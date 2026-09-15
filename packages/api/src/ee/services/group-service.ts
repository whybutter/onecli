import { db, type Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import {
  clampDirectoryLimit,
  decodeCursor,
  parseCursorDate,
  toDirectoryPage,
  type DirectoryPage,
} from "../lib/directory-page";
import { isUniqueViolation } from "../lib/prisma-errors";

/**
 * The org's human-group directory: list/create/rename/delete plus the three
 * membership writers — api-ee-behaviour §4.2, manual source only (this phase
 * ships no SCIM/directory sync, so every group this service creates is
 * `source: "manual"`; the SCIM-lock branch below is present so a manual
 * mutation on a future `scim`-sourced row is refused correctly, but nothing
 * in this build can ever CREATE one).
 *
 * Scoped to ONE organization on every call — the caller's
 * `auth.organizationId`, never a body/query parameter — via the
 * `findFirst({ id, organizationId })` / `updateMany|deleteMany({ id,
 * organizationId })` idiom the rest of the org surface uses, so a cross-org
 * id reads as absent (404) rather than leaking or mutating another tenant's
 * row.
 *
 * Role→group mappings (`GroupRoleMapping`, api-ee-behaviour §4.3) are NOT
 * implemented in this phase — no `/org/role-mappings` router exists yet, so
 * nothing populates that table. `team-service.ts`'s IdP-managed-role check
 * reads it defensively even so.
 */

export type GroupSource = "manual" | "scim";

/** One row of the groups directory (matches the client's `GroupRow`). */
export interface GroupRow {
  id: string;
  name: string;
  source: GroupSource;
  externalId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One row of a group's member list (matches the client's `GroupMemberRow`). */
export interface GroupMemberRow {
  userId: string;
  email: string;
  name: string | null;
  addedAt: string;
}

const GROUP_SELECT = {
  id: true,
  name: true,
  source: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: true } },
} satisfies Prisma.GroupSelect;

type GroupRowSource = {
  id: string;
  name: string;
  source: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { members: number };
};

/** The stored column is a plain string (no DB enum); every write path in
 * this file only ever sets "manual", and SCIM (not shipped in this phase)
 * would only ever set "scim" — an unrecognized value defaults to "manual"
 * rather than widening the wire type or throwing on a read. */
const asGroupSource = (value: string): GroupSource =>
  value === "scim" ? "scim" : "manual";

const toGroupRow = (row: GroupRowSource): GroupRow => ({
  id: row.id,
  name: row.name,
  source: asGroupSource(row.source),
  externalId: row.externalId,
  memberCount: row._count.members,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const GROUP_CURSOR_KEYS = ["name", "id"] as const;

/**
 * The shared keyset page over an arbitrary `Group` filter — `listOrgGroups`
 * below and `team-service.ts`'s `groupsFor` (the user→groups page) both
 * reduce to this with different `where` fragments. Ordered `(name asc, id
 * asc)`.
 */
export const listGroupsPage = async (
  where: Prisma.GroupWhereInput,
  params: { limit?: number; cursor?: string } = {},
): Promise<DirectoryPage<GroupRow>> => {
  const limit = clampDirectoryLimit(params.limit);
  const cursor = decodeCursor(params.cursor, GROUP_CURSOR_KEYS);

  const rows = await db.group.findMany({
    where: cursor
      ? {
          AND: [
            where,
            {
              OR: [
                { name: { gt: cursor.name } },
                { name: cursor.name, id: { gt: cursor.id } },
              ],
            },
          ],
        }
      : where,
    select: GROUP_SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  return toDirectoryPage(rows.map(toGroupRow), limit, (row) => ({
    name: row.name,
    id: row.id,
  }));
};

export interface ListOrgGroupsParams {
  limit?: number;
  cursor?: string;
  q?: string;
  source?: "manual" | "scim";
}

export const listOrgGroups = async (
  organizationId: string,
  params: ListOrgGroupsParams = {},
): Promise<DirectoryPage<GroupRow>> => {
  const q = params.q?.trim();
  return listGroupsPage(
    {
      organizationId,
      ...(params.source ? { source: params.source } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
    },
    params,
  );
};

/**
 * Resolve a group WITHIN the caller's org — always `findFirst({ id,
 * organizationId })`, NEVER `findUnique({ where: { id } })`: a cross-org id
 * must read as absent (404), not leak another org's row.
 */
const requireGroup = async (organizationId: string, groupId: string) => {
  const group = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: { id: true, name: true, source: true },
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found");
  return group;
};

const SCIM_LOCK_MESSAGE = "This group is managed by your identity provider.";

/** Mutations additionally require manual provenance ("scim" rows are IdP-owned). */
const requireManualGroup = async (organizationId: string, groupId: string) => {
  const group = await requireGroup(organizationId, groupId);
  if (group.source !== "manual") {
    throw new ServiceError("CONFLICT", SCIM_LOCK_MESSAGE);
  }
  return group;
};

export const getOrgGroup = async (
  organizationId: string,
  groupId: string,
): Promise<GroupRow> => {
  const row = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: GROUP_SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Group not found");
  return toGroupRow(row);
};

export const createOrgGroup = async (
  organizationId: string,
  name: string,
): Promise<GroupRow> => {
  try {
    const row = await db.group.create({
      // `source` is hard-coded: a create can never mint a "scim" row.
      data: { organizationId, name, source: "manual" },
      select: GROUP_SELECT,
    });
    return toGroupRow(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "A group with this name already exists.",
      );
    }
    throw err;
  }
};

export const renameOrgGroup = async (
  organizationId: string,
  groupId: string,
  name: string,
): Promise<GroupRow> => {
  await requireManualGroup(organizationId, groupId);

  try {
    // Org-scoped conditional write: a count of 0 means the row vanished
    // between the check and the write, which is a 404, not the P2025 500 a
    // bare `update()` would surface.
    const { count } = await db.group.updateMany({
      where: { id: groupId, organizationId },
      data: { name },
    });
    if (count === 0) throw new ServiceError("NOT_FOUND", "Group not found");
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "A group with this name already exists.",
      );
    }
    throw err;
  }

  return getOrgGroup(organizationId, groupId);
};

export interface DeletedGroup {
  id: string;
  name: string;
}

/**
 * Delete a group. The DB cascades take everything down with the row —
 * `GroupMember`, its `WorkspaceAccess` bindings, its `GroupRoleMapping`,
 * `PolicyRuleIdentity` and `AppAvailabilityRuleIdentity` rows.
 */
export const deleteOrgGroup = async (
  organizationId: string,
  groupId: string,
): Promise<DeletedGroup> => {
  const group = await requireManualGroup(organizationId, groupId);
  const { count } = await db.group.deleteMany({
    where: { id: groupId, organizationId },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Group not found");
  return { id: group.id, name: group.name };
};

// ─── Membership ─────────────────────────────────────────────────────────────

const MEMBER_CURSOR_KEYS = ["createdAt", "userId"] as const;

export interface ListOrgGroupMembersParams {
  limit?: number;
  cursor?: string;
  /** Accepted for wire compatibility with the shared query schema; ignored. */
  q?: string;
}

export const listOrgGroupMembers = async (
  organizationId: string,
  groupId: string,
  params: ListOrgGroupMembersParams = {},
): Promise<DirectoryPage<GroupMemberRow>> => {
  await requireGroup(organizationId, groupId);
  const limit = clampDirectoryLimit(params.limit);
  const cursor = decodeCursor(params.cursor, MEMBER_CURSOR_KEYS);
  const after = cursor ? parseCursorDate(cursor.createdAt) : undefined;

  const rows = await db.groupMember.findMany({
    where: {
      groupId,
      ...(after
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { gt: after } },
                  { createdAt: after, userId: { gt: cursor!.userId } },
                ],
              },
            ],
          }
        : {}),
    },
    select: {
      userId: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    take: limit + 1,
  });

  const mapped: GroupMemberRow[] = rows.map((row) => ({
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    addedAt: row.createdAt.toISOString(),
  }));

  return toDirectoryPage(mapped, limit, (row) => ({
    createdAt: row.addedAt,
    userId: row.userId,
  }));
};

export interface GroupMembersDelta {
  added: number;
  removed: number;
}

/**
 * `PUT /org/groups/:groupId/members`: full-replace in one transaction.
 * Every id must be an org member of ANY status (suspended included — this
 * only shapes who a group can name, not who currently has access); a
 * preserved-but-now-suspended member never blocks the write since only the
 * ADDED ids are validated.
 */
export const setOrgGroupMembers = async (
  organizationId: string,
  actorUserId: string,
  groupId: string,
  userIds: string[],
): Promise<GroupMembersDelta> => {
  await requireManualGroup(organizationId, groupId);
  const desired = [...new Set(userIds)];

  const current = await db.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  const currentIds = new Set(current.map((m) => m.userId));
  const desiredSet = new Set(desired);
  const toAdd = desired.filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !desiredSet.has(id));

  if (toAdd.length === 0 && toRemove.length === 0) {
    return { added: 0, removed: 0 };
  }

  if (toAdd.length > 0) {
    const members = await db.organizationMember.findMany({
      where: { organizationId, userId: { in: toAdd } },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    const notMembers = toAdd.filter((id) => !memberIds.has(id));
    if (notMembers.length > 0) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Not members of this organization: ${notMembers.join(", ")}`,
      );
    }
  }

  await db.$transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx.groupMember.deleteMany({
        where: { groupId, userId: { in: toRemove } },
      });
    }
    if (toAdd.length > 0) {
      await tx.groupMember.createMany({
        data: toAdd.map((userId) => ({
          groupId,
          userId,
          createdByUserId: actorUserId,
        })),
        skipDuplicates: true,
      });
    }
  });

  return { added: toAdd.length, removed: toRemove.length };
};

export interface GroupMemberAddResult {
  added: boolean;
}

/** `PUT /org/groups/:groupId/members/:userId`: idempotent single add. */
export const addOrgGroupMember = async (
  organizationId: string,
  actorUserId: string,
  groupId: string,
  userId: string,
): Promise<GroupMemberAddResult> => {
  await requireManualGroup(organizationId, groupId);

  const member = await db.organizationMember.findFirst({
    where: { organizationId, userId },
    select: { userId: true },
  });
  if (!member) {
    throw new ServiceError(
      "BAD_REQUEST",
      "User is not a member of this organization",
    );
  }

  const existing = await db.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { userId: true },
  });
  if (existing) return { added: false };

  await db.groupMember.create({
    data: { groupId, userId, createdByUserId: actorUserId },
  });
  return { added: true };
};

export interface GroupMemberRemoveResult {
  removed: boolean;
}

/** `DELETE /org/groups/:groupId/members/:userId`: idempotent single remove. */
export const removeOrgGroupMember = async (
  organizationId: string,
  groupId: string,
  userId: string,
): Promise<GroupMemberRemoveResult> => {
  await requireManualGroup(organizationId, groupId);
  const { count } = await db.groupMember.deleteMany({
    where: { groupId, userId },
  });
  return { removed: count > 0 };
};
