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
 * The access law (api-ee-behaviour §2.3), Phase 0 of the v2 migration:
 *
 * - `getUserRole` is the suspension choke point: a suspended membership reads
 *   as no membership, so every gate below denies through it.
 * - Usage of a workspace is bindings-only: an org owner/admin reaches every
 *   workspace in the org; a member reaches the ones they hold a DIRECT
 *   `workspace_access` binding on. Group bindings arrive with groups (Phase 1).
 * - Management (rename / share / delete) is org owner/admin, or a direct
 *   binding with role `owner`. Creating a workspace only matters because it
 *   seeds that owner binding; there is no creator arm.
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

/** Whether the user holds a direct `workspace_access` binding on the workspace. */
export const hasWorkspaceAccessBinding = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const binding = await db.workspaceAccess.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  });
  return binding !== null;
};

/**
 * The `where` fragment selecting the workspaces a user may see in an org:
 * admins get the whole org; members get the ones they hold a binding on.
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
    : { organizationId, accessBindings: { some: { userId } } };

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
  if (await hasWorkspaceAccessBinding(userId, workspaceId)) return true;
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
    return hasWorkspaceAccessBinding(userId, workspace.id);
  },
  userIsOrgAdmin: async (userId, organizationId) =>
    hasMinimumRole(await getUserRole(userId, organizationId), "admin"),
};
