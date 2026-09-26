import { db, type Prisma } from "@onecli/db";
import {
  ROLE_HIERARCHY,
  type OrgRole,
  type WorkspaceAccessChecker,
} from "../../providers/types";
import { ServiceError } from "../../services/errors";
import { activeMembershipWhere } from "../../services/organization-service";

export type { OrgRole };

/**
 * Who may see, use and manage a workspace, and who is an org admin — the one
 * place every route, server action and the shared access checker ask.
 *
 * The access law (api-ee-behaviour §2.3), Phase 2 of the v2 migration:
 *
 * - `getUserRole` is the suspension choke point: a suspended membership reads
 *   as no membership, so every gate below denies through it.
 * - Usage of a workspace is bindings-only: an org owner/admin reaches every
 *   workspace in the org; a member reaches the ones they hold a DIRECT
 *   `workspace_access` binding on, OR an INDIRECT one through a `groupId`
 *   binding naming a group they belong to (the GROUP arm, added in Phase 2).
 *   A group binding must itself belong to the workspace's organization — the
 *   same org fence the free `policy-simulate/principal-set.ts` CTE applies —
 *   so a user's membership in another org's groups can never leak in.
 * - Management (rename / share / delete) is org owner/admin, or a direct
 *   USER binding with role `owner`. Group bindings NEVER confer management,
 *   no matter the role stored on the row (group rows are always `member`
 *   anyway) — this is deliberate per spec §2.3, not an oversight: widening it
 *   would let anyone who can edit group membership escalate to workspace
 *   management. Creating a workspace only matters because it seeds the
 *   creator's owner binding; there is no creator arm.
 */

const isOrgRole = (value: string): value is OrgRole =>
  Object.hasOwn(ROLE_HIERARCHY, value);

export const hasMinimumRole = (
  role: OrgRole | null,
  minimum: OrgRole,
): boolean => role !== null && ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minimum];

/**
 * The user's role in an organization, or `null` when they are not a member
 * OR their membership is suspended. Also the `RoleResolver` the auth
 * middleware, the org-key re-check and the invitations router read through.
 */
export const getUserRole = async (
  userId: string,
  organizationId: string,
): Promise<OrgRole | null> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status === "suspended") return null;
  return isOrgRole(membership.role) ? membership.role : null;
};

/**
 * Resolve the caller's role and refuse below `minimumRole`. Mirrors the auth
 * middleware's 403s: no active membership → "Not a member of this
 * organization"; below the threshold → "Insufficient permissions".
 */
export const requireRole = async (
  userId: string,
  organizationId: string,
  minimumRole: OrgRole,
): Promise<OrgRole> => {
  const role = await getUserRole(userId, organizationId);
  if (!role) {
    throw new ServiceError("FORBIDDEN", "Not a member of this organization");
  }
  if (!hasMinimumRole(role, minimumRole)) {
    throw new ServiceError("FORBIDDEN", "Insufficient permissions");
  }
  return role;
};

/** Org owners and admins see and manage every workspace in their organization. */
export const canManageAllWorkspaces = (role: OrgRole | null): boolean =>
  hasMinimumRole(role, "admin");

/**
 * Whether the user holds a `workspace_access` binding on the workspace —
 * either DIRECT (their own `userId` row) or via a GROUP they belong to. The
 * group must belong to the workspace's organization: the same shape the free
 * `policy-simulate/principal-set.ts` CTE resolves (direct users ∪ members of
 * org-fenced granted groups), without importing it — that file is a
 * LICENSED-MIRROR the free hot path executes and must not depend on `ee/`.
 */
export const hasWorkspaceAccessBinding = async (
  userId: string,
  workspaceId: string,
  organizationId: string,
): Promise<boolean> => {
  const direct = await db.workspaceAccess.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  });
  if (direct !== null) return true;

  // Belt-and-suspenders org fence on the group itself, mirroring
  // `principal-set.ts`'s `direct_groups` CTE arm: a `workspace_access` row's
  // `groupId` should only ever name a group of this workspace's own
  // organization (write-time validation in `group-service.ts`'s
  // `setWorkspaceAccessBindings` enforces that), but the read re-checks it
  // rather than trusting the write path never drifts.
  const group = await db.workspaceAccess.findFirst({
    where: {
      workspaceId,
      groupId: { not: null },
      group: { organizationId, members: { some: { userId } } },
    },
    select: { id: true },
  });
  return group !== null;
};

/**
 * The `where` fragment selecting the workspaces a user may see in an org:
 * admins get the whole org; members get the ones they hold a DIRECT binding
 * on, OR an INDIRECT one through a group binding naming a group they belong
 * to (org-fenced via the relation traversal itself: `WorkspaceAccess.group`
 * only ever names a group of the workspace's own organization — see the
 * `@@unique([organizationId, name])` / creation path in `group-service.ts`).
 * Status-blind by design — callers pass an org the user is an ACTIVE member
 * of (the auth layer has already fenced that).
 */
export const visibleWorkspacesWhere = (
  userId: string,
  organizationId: string,
  role: OrgRole | null,
): Prisma.WorkspaceWhereInput =>
  canManageAllWorkspaces(role)
    ? { organizationId }
    : {
        organizationId,
        accessBindings: {
          some: {
            OR: [
              { userId },
              {
                groupId: { not: null },
                group: { organizationId, members: { some: { userId } } },
              },
            ],
          },
        },
      };

/**
 * The visibility fence shared by the two predicates below: the workspace
 * must exist in an organization the user is a non-suspended member of.
 * Returns the org id so the caller can resolve the role without a second
 * membership read; `null` means "answer false without leaking existence".
 */
const visibleWorkspaceOrg = async (
  userId: string,
  workspaceId: string,
): Promise<string | null> => {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      organization: {
        members: { some: { userId, ...activeMembershipWhere } },
      },
    },
    select: { organizationId: true },
  });
  return workspace?.organizationId ?? null;
};

/** May the user USE the workspace: a direct binding, or org owner/admin. */
export const canAccessWorkspace = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const organizationId = await visibleWorkspaceOrg(userId, workspaceId);
  if (!organizationId) return false;
  if (await hasWorkspaceAccessBinding(userId, workspaceId, organizationId)) {
    return true;
  }
  return canManageAllWorkspaces(await getUserRole(userId, organizationId));
};

/**
 * May the user MANAGE the workspace (rename / share / delete): org
 * owner/admin, else a direct binding with role `owner`. A plain use binding
 * never confers management.
 */
export const canManageWorkspace = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const organizationId = await visibleWorkspaceOrg(userId, workspaceId);
  if (!organizationId) return false;
  if (canManageAllWorkspaces(await getUserRole(userId, organizationId))) {
    return true;
  }
  const binding = await db.workspaceAccess.findFirst({
    where: { workspaceId, userId, role: "owner" },
    select: { id: true },
  });
  return binding !== null;
};

/**
 * The `WorkspaceAccessChecker` slot implementation behind the shared
 * predicates in `services/workspace-access-check.ts`.
 *
 * ORDER IS THE INVARIANT: the role is read first, so a non-member or
 * suspended user is denied without a single binding query (a stale binding
 * can never rescue them), and an owner/admin is allowed without one.
 */
export const eeWorkspaceAccessChecker: WorkspaceAccessChecker = {
  // `workspace` is trusted as-is per the slot contract: the caller must have
  // read the (id, organizationId) pair from the database, never from input.
  canAccessWorkspaceAsUser: async (userId, workspace) => {
    const role = await getUserRole(userId, workspace.organizationId);
    if (!role) return false;
    if (canManageAllWorkspaces(role)) return true;
    return hasWorkspaceAccessBinding(
      userId,
      workspace.id,
      workspace.organizationId,
    );
  },
  userIsOrgAdmin: async (userId, organizationId) =>
    hasMinimumRole(await getUserRole(userId, organizationId), "admin"),
};
