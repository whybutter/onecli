import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { assertCanShareWorkspace, assertFeatureAllowed } from "./quota-service";

/**
 * The org-scoped human-sharing surface for ONE workspace —
 * `/workspaces/:id/access` (api-ee-behaviour §2.2). Read/write both take a
 * workspace already resolved and management-checked by
 * `requireWorkspaceManagement`; nothing here re-derives visibility.
 *
 * Bindings and the predicates that consult them (`hasWorkspaceAccessBinding`,
 * `visibleWorkspacesWhere`) live in `authorization-service.ts`, which stays
 * read-only over `workspace_access`; this file owns the writes.
 */

const PLACEHOLDER_EMAIL_SUFFIX = "@onecli.internal";

export interface WorkspaceAccessUserRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: "owner" | "member";
  isOwner: boolean;
  createdAt: string;
}

export interface WorkspaceAccessGroupRow {
  id: string;
  groupId: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface WorkspaceAccessBindings {
  users: WorkspaceAccessUserRow[];
  groups: WorkspaceAccessGroupRow[];
}

/**
 * `GET /workspaces/:id/access`: every binding on the workspace, users and
 * groups. Rows ordered by createdAt; placeholder users omitted; any stored
 * role other than `owner` reads as `member`; `isOwner` flags the workspace's
 * creator (a display hint, independent of the transferable management role).
 */
export const getWorkspaceAccessBindings = async (
  workspaceId: string,
): Promise<WorkspaceAccessBindings> => {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { createdByUserId: true },
  });

  const rows = await db.workspaceAccess.findMany({
    where: { workspaceId },
    select: {
      id: true,
      userId: true,
      groupId: true,
      role: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
      group: { select: { name: true, _count: { select: { members: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  const users: WorkspaceAccessUserRow[] = [];
  const groups: WorkspaceAccessGroupRow[] = [];
  for (const row of rows) {
    if (row.userId) {
      if (row.user?.email?.endsWith(PLACEHOLDER_EMAIL_SUFFIX)) continue;
      users.push({
        id: row.id,
        userId: row.userId,
        name: row.user?.name ?? null,
        email: row.user?.email ?? "",
        role: row.role === "owner" ? "owner" : "member",
        isOwner: row.userId === workspace?.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      });
    } else if (row.groupId) {
      groups.push({
        id: row.id,
        groupId: row.groupId,
        name: row.group?.name ?? "",
        memberCount: row.group?._count.members ?? 0,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }
  return { users, groups };
};

export interface SetWorkspaceAccessInput {
  users: { userId: string; role: "owner" | "member" }[];
  groupIds: string[];
}

export interface SetWorkspaceAccessResult {
  added: number;
  removed: number;
  roleChanged: number;
}

/**
 * `PUT /workspaces/:id/access`: replace the FULL desired set in one
 * transaction (api-ee-behaviour §2.2 "Replace semantics").
 *
 * - Dedupe users by id (last role wins) and group ids.
 * - Diff against the current rows: absent users/groups are removed
 *   (including the creator's own binding — a UI warning only, org admins
 *   remain the backstop); preserved users whose role differs are re-roled IN
 *   PLACE (update, never delete+recreate); no-op short-circuits before any
 *   transaction when nothing differs.
 * - Only ADDITIONS are validated (new users must be ACTIVE members of the
 *   org; new groups must belong to it) and only additions trip the
 *   entitlement gates — preserving or removing a binding, or re-roling one,
 *   never re-trips a gate.
 * - Creates use skip-duplicates so a concurrent double-add is idempotent;
 *   new rows record `createdByUserId` = actor. Group bindings carry no role
 *   (always stored as `member`).
 */
export const setWorkspaceAccessBindings = async (
  organizationId: string,
  workspaceId: string,
  actorUserId: string,
  input: SetWorkspaceAccessInput,
): Promise<SetWorkspaceAccessResult> => {
  const desiredUserRole = new Map<string, "owner" | "member">();
  for (const user of input.users) desiredUserRole.set(user.userId, user.role);
  const desiredGroupIds = new Set(input.groupIds);

  const current = await db.workspaceAccess.findMany({
    where: { workspaceId },
    select: { userId: true, groupId: true, role: true },
  });
  const currentUserRole = new Map(
    current
      .filter((row): row is typeof row & { userId: string } => !!row.userId)
      .map((row) => [row.userId, row.role]),
  );
  const currentGroupIds = new Set(
    current.flatMap((row) => (row.groupId ? [row.groupId] : [])),
  );

  const usersToAdd = [...desiredUserRole.keys()].filter(
    (id) => !currentUserRole.has(id),
  );
  const usersToRemove = [...currentUserRole.keys()].filter(
    (id) => !desiredUserRole.has(id),
  );
  const usersToReRole = [...desiredUserRole.entries()].filter(
    ([id, role]) => currentUserRole.has(id) && currentUserRole.get(id) !== role,
  );
  const groupsToAdd = [...desiredGroupIds].filter(
    (id) => !currentGroupIds.has(id),
  );
  const groupsToRemove = [...currentGroupIds].filter(
    (id) => !desiredGroupIds.has(id),
  );

  if (
    usersToAdd.length === 0 &&
    usersToRemove.length === 0 &&
    usersToReRole.length === 0 &&
    groupsToAdd.length === 0 &&
    groupsToRemove.length === 0
  ) {
    return { added: 0, removed: 0, roleChanged: 0 };
  }

  if (usersToAdd.length > 0) {
    const activeMembers = await db.organizationMember.findMany({
      where: {
        organizationId,
        userId: { in: usersToAdd },
        status: { not: "suspended" },
      },
      select: { userId: true },
    });
    const activeIds = new Set(activeMembers.map((m) => m.userId));
    const notActive = usersToAdd.filter((id) => !activeIds.has(id));
    if (notActive.length > 0) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Not active members of this organization: ${notActive.join(", ")}`,
      );
    }
    await assertCanShareWorkspace(organizationId);
  }

  if (groupsToAdd.length > 0) {
    const orgGroups = await db.group.findMany({
      where: { organizationId, id: { in: groupsToAdd } },
      select: { id: true },
    });
    const orgGroupIds = new Set(orgGroups.map((g) => g.id));
    const notInOrg = groupsToAdd.filter((id) => !orgGroupIds.has(id));
    if (notInOrg.length > 0) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Groups not in this organization: ${notInOrg.join(", ")}`,
      );
    }
    await assertFeatureAllowed(organizationId, "groups");
  }

  await db.$transaction(async (tx) => {
    if (usersToRemove.length > 0) {
      await tx.workspaceAccess.deleteMany({
        where: { workspaceId, userId: { in: usersToRemove } },
      });
    }
    if (groupsToRemove.length > 0) {
      await tx.workspaceAccess.deleteMany({
        where: { workspaceId, groupId: { in: groupsToRemove } },
      });
    }
    for (const [userId, role] of usersToReRole) {
      await tx.workspaceAccess.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role },
      });
    }
    if (usersToAdd.length > 0) {
      await tx.workspaceAccess.createMany({
        data: usersToAdd.map((userId) => ({
          workspaceId,
          userId,
          role: desiredUserRole.get(userId) ?? "member",
          createdByUserId: actorUserId,
        })),
        skipDuplicates: true,
      });
    }
    if (groupsToAdd.length > 0) {
      await tx.workspaceAccess.createMany({
        data: groupsToAdd.map((groupId) => ({
          workspaceId,
          groupId,
          createdByUserId: actorUserId,
        })),
        skipDuplicates: true,
      });
    }
  });

  return {
    added: usersToAdd.length + groupsToAdd.length,
    removed: usersToRemove.length + groupsToRemove.length,
    roleChanged: usersToReRole.length,
  };
};
