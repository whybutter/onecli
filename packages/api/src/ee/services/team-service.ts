import { db } from "@onecli/db";
import { invalidateGatewayCacheForKeys } from "../../lib/gateway-invalidate";
import { logger } from "../../lib/logger";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  recordAuditEvent,
} from "../../services/audit-service";
import { ASSIGNABLE_MEMBER_ROLES } from "../../services/organization-service";
import { deleteWorkspace } from "./workspace-service";

const log = logger.child({ component: "team-service" });

export interface TeamMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  ssoExempt: boolean;
  roleManagedByIdp?: boolean;
  joinedAt: Date;
}

/**
 * What happened to the departing member's LOGIN. Identity revocation was a
 * Cognito arm; there is no identity provider to revoke against in this
 * build, so the outcome is always `"skipped"`. The vocabulary is kept for
 * wire compatibility with the audits and responses that carry it.
 */
export type RevocationOutcome =
  | "disabled"
  | "membership_only"
  | "skipped"
  | "failed";

/** Seat-warmer placeholder identities are hidden from every human list. */
const PLACEHOLDER_EMAIL_SUFFIX = "@onecli.internal";

type KeyRevocationReason = "role_change" | "member_removed";

/**
 * Revoke the API keys a member can no longer be trusted with: their org
 * keys in this org, and their workspace keys on this org's workspaces
 * (`non_owned` spares the workspaces they created themselves — a demotion
 * keeps a member's own workspace keys). Best-effort: a failure is logged
 * and never fails the parent operation. Audited under the affected user.
 */
const revokeKeysForLostAccess = async (
  organizationId: string,
  userId: string,
  reason: KeyRevocationReason,
  scope: "all" | "non_owned",
): Promise<void> => {
  try {
    const keys = await db.apiKey.findMany({
      where: {
        userId,
        OR: [
          { scope: "organization", organizationId },
          {
            scope: "workspace",
            workspace: {
              organizationId,
              ...(scope === "non_owned"
                ? { NOT: { createdByUserId: userId } }
                : {}),
            },
          },
        ],
      },
      select: { id: true, key: true, userEmail: true },
    });
    if (keys.length === 0) return;

    await db.apiKey.deleteMany({
      where: { id: { in: keys.map((key) => key.id) } },
    });
    invalidateGatewayCacheForKeys(keys.map((key) => key.key));
    await recordAuditEvent({
      organizationId,
      userId,
      userEmail: keys[0]?.userEmail ?? "",
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.API_KEY,
      metadata: { reason, revokedCount: keys.length },
    });
  } catch (err) {
    log.warn(
      { err, organizationId, userId, reason },
      "api key revocation failed; continuing",
    );
  }
};

const requireMembership = async (
  organizationId: string,
  userId: string,
): Promise<{ role: string; userEmail: string }> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, userEmail: true },
  });
  if (!membership) throw new Error("User is not a member of this organization");
  return membership;
};

/**
 * Every member of the organization for the team page, oldest first,
 * placeholders excluded. `roleManagedByIdp` is true when a non-owner sits
 * in a group that carries a role mapping (none exist until groups land).
 */
export const listMembers = async (
  organizationId: string,
): Promise<TeamMember[]> => {
  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      NOT: { userEmail: { endsWith: PLACEHOLDER_EMAIL_SUFFIX } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      userId: true,
      userEmail: true,
      role: true,
      status: true,
      ssoExempt: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  });
  if (rows.length === 0) return [];

  const mapped = await db.groupMember.findMany({
    where: {
      userId: { in: rows.map((row) => row.userId) },
      group: { organizationId, roleMapping: { isNot: null } },
    },
    select: { userId: true },
  });
  const managedUserIds = new Set(mapped.map((row) => row.userId));

  return rows.map((row) => ({
    userId: row.userId,
    email: row.user?.email ?? row.userEmail,
    name: row.user?.name ?? null,
    role: row.role,
    status: row.status,
    ssoExempt: row.ssoExempt,
    roleManagedByIdp: row.role !== "owner" && managedUserIds.has(row.userId),
    joinedAt: row.createdAt,
  }));
};

/**
 * Change a member's role to `admin` or `member`. The owner's role is fixed
 * (it is conferred by creating the org). A demotion to `member` revokes the
 * keys on workspaces the member did not create. Not audited here — the
 * caller audits with its own actor.
 */
export const changeMemberRole = async (
  organizationId: string,
  targetUserId: string,
  newRole: string,
): Promise<void> => {
  if (!ASSIGNABLE_MEMBER_ROLES.has(newRole)) throw new Error("Invalid role");
  const membership = await requireMembership(organizationId, targetUserId);
  if (membership.role === "owner") {
    throw new Error("The owner's role cannot be changed");
  }

  await db.organizationMember.update({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    data: { role: newRole },
  });

  if (newRole === "member") {
    await revokeKeysForLostAccess(
      organizationId,
      targetUserId,
      "role_change",
      "non_owned",
    );
  }
};

/**
 * The workspaces that leave with a member: the ones they created in this
 * org, still hold their own binding on, and that nobody else is bound to
 * (no other user's direct binding, no group binding). A workspace they
 * shared, or were removed from and an admin adopted, survives. This is
 * exactly the set `removeMember` deletes; the leave/remove dialogs show it.
 */
export const findDeletablePersonalWorkspaces = async (
  organizationId: string,
  userId: string,
): Promise<
  { id: string; name: string | null; channelApps: { provider: string }[] }[]
> => {
  const workspaces = await db.workspace.findMany({
    where: {
      organizationId,
      createdByUserId: userId,
      accessBindings: { some: { userId } },
      NOT: {
        accessBindings: {
          some: {
            OR: [{ userId: { not: userId } }, { groupId: { not: null } }],
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
      agents: { select: { channels: { select: { provider: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  return workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    channelApps: workspace.agents.flatMap((agent) =>
      agent.channels.map((channel) => ({ provider: channel.provider })),
    ),
  }));
};

/**
 * Remove a member (an admin removing them, or the member leaving). The
 * organization owner can never be removed — a domain rule, not a licence
 * rule. Order: their truly-personal workspaces go (full cascade + key
 * flush), then every key of theirs in this org, then the bindings they were
 * shared INTO, their group memberships here, and finally the membership
 * row. `revokeIdentity: false` is the voluntary-leave shape; either way the
 * login is untouched in this build, so the outcome is `"skipped"`.
 * Not audited here — callers audit with their own actor.
 */
export type RemoveMember = (
  organizationId: string,
  targetUserId: string,
  options?: { revokeIdentity?: boolean },
) => Promise<RevocationOutcome>;

export const removeMember: RemoveMember = async (
  organizationId,
  targetUserId,
) => {
  const membership = await requireMembership(organizationId, targetUserId);
  if (membership.role === "owner") {
    throw new Error("The organization owner cannot be removed");
  }

  const personal = await findDeletablePersonalWorkspaces(
    organizationId,
    targetUserId,
  );
  for (const workspace of personal) {
    await deleteWorkspace(workspace.id);
  }

  await revokeKeysForLostAccess(
    organizationId,
    targetUserId,
    "member_removed",
    "all",
  );
  await db.workspaceAccess.deleteMany({
    where: { userId: targetUserId, workspace: { organizationId } },
  });
  await db.groupMember.deleteMany({
    where: { userId: targetUserId, group: { organizationId } },
  });
  await db.organizationMember.delete({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
  });

  return "skipped";
};
