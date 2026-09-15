import { db, Prisma } from "@onecli/db";
import { invalidateGatewayCacheForKeys } from "../../lib/gateway-invalidate";
import { logger } from "../../lib/logger";
import { ServiceError } from "../../services/errors";
import { bootstrapOrganization } from "../../services/organization-service";
import { assertCanCreateOrganization } from "./quota-service";
import { deleteWorkspace } from "./workspace-service";

const log = logger.child({ component: "organization-service" });

/**
 * The web "New organization" flow: the shared bootstrap (org + owner
 * membership + default workspace, atomic, then the best-effort policy seed).
 * The bootstrap's deterministic slug turns a duplicate name into a unique
 * violation, which reads back as a 409 naming the organization; anything
 * else propagates unchanged. There is no cap on organizations per user.
 */
export const createOrganization = async (
  userId: string,
  userEmail: string,
  displayName?: string,
) => {
  await assertCanCreateOrganization(userId);
  try {
    return await bootstrapOrganization(userId, userEmail, displayName);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        displayName
          ? `You already have an organization named "${displayName}". Please choose a different name.`
          : "You already have an organization with this name. Please choose a different name.",
      );
    }
    throw err;
  }
};

/**
 * The hand-written organization cascade, inside the caller's transaction,
 * for an org whose workspaces are already gone. Returns the org-scoped API
 * keys it deleted so the caller can flush the gateway cache after commit.
 */
export const deleteOrganizationContent = async (
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> => {
  const keys = await tx.apiKey.findMany({
    where: { organizationId },
    select: { key: true },
  });
  await tx.auditLog.deleteMany({ where: { organizationId } });
  await tx.skill.deleteMany({ where: { organizationId } });
  await tx.secret.deleteMany({ where: { organizationId } });
  await tx.apiKey.deleteMany({ where: { organizationId } });
  await tx.appConfig.deleteMany({ where: { organizationId } });
  await tx.appConnection.deleteMany({ where: { organizationId } });
  await tx.invitation.deleteMany({ where: { organizationId } });
  await tx.userProvision.deleteMany({ where: { organizationId } });
  await tx.budgetSpend.deleteMany({ where: { organizationId } });
  await tx.budget.deleteMany({ where: { organizationId } });
  // These four FKs are `onDelete: Restrict` (verified by a pg test in
  // `organization-service.pg.test.ts`), so they must go before the org row
  // or the delete fails loudly rather than orphaning identity state:
  // app-availability rules, org domains, the org's one SSO connection, and
  // its SCIM tokens. `appAvailabilityRuleIdentity` cascades from the rule.
  await tx.appAvailabilityRule.deleteMany({ where: { organizationId } });
  await tx.organizationDomain.deleteMany({ where: { organizationId } });
  await tx.organizationSsoConnection.deleteMany({ where: { organizationId } });
  await tx.organizationScimToken.deleteMany({ where: { organizationId } });
  await tx.groupRoleMapping.deleteMany({ where: { organizationId } });
  await tx.group.deleteMany({ where: { organizationId } });
  await tx.organizationMember.deleteMany({ where: { organizationId } });
  await tx.organization.delete({ where: { id: organizationId } });
  return keys.map((row) => row.key);
};

/**
 * Delete an organization outright. Only its ACTIVE owner may. Every
 * workspace goes first, each in its own bounded transaction, then the org
 * itself. Not audited: the org's audit rows are deleted with it.
 */
export const deleteOrganization = async (
  organizationId: string,
  userId: string,
): Promise<void> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, status: true },
  });
  if (
    !membership ||
    membership.role !== "owner" ||
    membership.status === "suspended"
  ) {
    throw new Error("Only the organization owner can delete it");
  }

  const workspaces = await db.workspace.findMany({
    where: { organizationId },
    select: { id: true },
  });
  for (const workspace of workspaces) {
    await deleteWorkspace(workspace.id);
  }

  const keys = await db.$transaction((tx) =>
    deleteOrganizationContent(organizationId, tx),
  );
  invalidateGatewayCacheForKeys(keys);
  log.info(
    { organizationId, userId, workspaces: workspaces.length },
    "organization deleted",
  );
};
