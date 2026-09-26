import { randomUUID } from "node:crypto";
import { db } from "@onecli/db";
import { invalidateGatewayCacheForKeys } from "../../lib/gateway-invalidate";
import { logger } from "../../lib/logger";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  recordAuditEvent,
} from "../../services/audit-service";
import { ServiceError } from "../../services/errors";
import { ASSIGNABLE_MEMBER_ROLES } from "../../services/organization-service";
import {
  clampDirectoryLimit,
  decodeCursor,
  parseCursorDate,
  toDirectoryPage,
  type DirectoryPage,
} from "../lib/directory-page";
import { isUniqueViolation } from "../lib/prisma-errors";
import { listGroupsPage, type GroupRow } from "./group-service";
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
  if (!membership) {
    throw new ServiceError(
      "NOT_FOUND",
      "User is not a member of this organization",
    );
  }
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

  // IdP-managed lock: a member sitting in any group that carries a role
  // mapping has their role assigned by directory automation, not by hand.
  // Real read against `GroupRoleMapping` — nothing populates that table yet
  // (no `/org/role-mappings` router in this phase), so this is unreachable
  // today; it exists so the lock is already in place the day one does.
  const managed = await db.groupMember.findFirst({
    where: {
      userId: targetUserId,
      group: { organizationId, roleMapping: { isNot: null } },
    },
    select: { userId: true },
  });
  if (managed) {
    throw new ServiceError(
      "CONFLICT",
      "This member's role is managed by your identity provider.",
    );
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

export interface RemoveMemberResult {
  revocation: RevocationOutcome;
  /** The removed member's email, for the caller's audit metadata. */
  email: string;
}

/**
 * Remove a member (an admin removing them, or the member leaving). The
 * organization owner can never be removed — a domain rule, not a licence
 * rule. Guards run BEFORE any destructive step (mirrors suspendMember):
 * NOT_FOUND for a non-member, BAD_REQUEST for the owner, both typed so the
 * route needs no separate pre-check query. Order once past the guards:
 * their truly-personal workspaces go (full cascade + key flush), then every
 * key of theirs in this org, then the bindings they were shared INTO, their
 * group memberships here, and finally the membership row. `revokeIdentity:
 * false` is the voluntary-leave shape; either way the login is untouched in
 * this build, so the outcome is `"skipped"`. Not audited here — callers
 * audit with their own actor.
 */
export type RemoveMember = (
  organizationId: string,
  targetUserId: string,
  options?: { revokeIdentity?: boolean },
) => Promise<RemoveMemberResult>;

export const removeMember: RemoveMember = async (
  organizationId,
  targetUserId,
) => {
  const membership = await requireMembership(organizationId, targetUserId);
  if (membership.role === "owner") {
    throw new ServiceError(
      "BAD_REQUEST",
      "The organization owner cannot be removed",
    );
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

  return { revocation: "skipped", email: membership.userEmail };
};

// ─── Directory list, suspend/reinstate, create, and the user→groups page ──

/** One row of the members directory (matches the client's `OrgMemberListRow`
 * — deliberately WITHOUT `roleManagedByIdp`, unlike the free `listMembers`
 * above; the two lists serve different pages). */
export interface OrgMemberListRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  ssoExempt: boolean;
  joinedAt: string;
}

export interface ListMembersPageParams {
  limit?: number;
  cursor?: string;
  q?: string;
  status?: "active" | "suspended";
}

const MEMBER_CURSOR_KEYS = ["createdAt", "userId"] as const;

/**
 * The `/org/members` directory page (api-ee-behaviour §1.2/§0.4): ordered
 * `(createdAt asc, userId asc)`, placeholders excluded, `q` a case-insensitive
 * contains over email OR display name.
 */
export const listMembersPage = async (
  organizationId: string,
  params: ListMembersPageParams = {},
): Promise<DirectoryPage<OrgMemberListRow>> => {
  const limit = clampDirectoryLimit(params.limit);
  const cursor = decodeCursor(params.cursor, MEMBER_CURSOR_KEYS);
  const after = cursor ? parseCursorDate(cursor.createdAt) : undefined;
  const q = params.q?.trim();

  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      NOT: { userEmail: { endsWith: PLACEHOLDER_EMAIL_SUFFIX } },
      ...(params.status ? { status: params.status } : {}),
      ...(q
        ? {
            OR: [
              { userEmail: { contains: q, mode: "insensitive" as const } },
              { user: { name: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
      // The keyset predicate lives under its own AND, never as a top-level
      // `OR` spread: a future filter that also needs `OR` (like `q` above)
      // would otherwise overwrite the cursor clause.
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
      userEmail: true,
      role: true,
      status: true,
      ssoExempt: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    take: limit + 1,
  });

  const mapped: OrgMemberListRow[] = rows.map((row) => ({
    userId: row.userId,
    email: row.user?.email ?? row.userEmail,
    name: row.user?.name ?? null,
    role: row.role,
    status: row.status,
    ssoExempt: row.ssoExempt,
    joinedAt: row.createdAt.toISOString(),
  }));

  return toDirectoryPage(mapped, limit, (row) => ({
    createdAt: row.joinedAt,
    userId: row.userId,
  }));
};

const MEMBER_ALREADY_EXISTS =
  "This user is already a member of the organization.";

export interface CreatedMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  ssoExempt: boolean;
  joinedAt: string;
  /** Route-only: folded into the audit metadata, dropped from the response. */
  userCreated: boolean;
}

/**
 * `POST /org/members`: create the user if unknown (a `scim-<uuid>` placeholder
 * auth id — this is a manual, non-directory provisioning door, but the
 * placeholder-id convention is shared with the real SCIM/JIT doors) and an
 * active `member` membership.
 *
 * Two existence checks, not one: the fast pre-check by `userEmail` covers the
 * common case cheaply, but an EXISTING user's row can carry a different
 * canonical email than the one this call was given (their email changed
 * elsewhere since they joined) — the by-`userId` check after resolving the
 * user catches that. `organizationMember.create`'s own unique-violation
 * catch is the last line of defense, for the concurrent-double-add race
 * neither read can see.
 */
export const createMember = async (
  organizationId: string,
  email: string,
  name: string | null,
): Promise<CreatedMember> => {
  const existingMembership = await db.organizationMember.findFirst({
    where: { organizationId, userEmail: email },
    select: { userId: true },
  });
  if (existingMembership) {
    throw new ServiceError("CONFLICT", MEMBER_ALREADY_EXISTS);
  }

  let user = await db.user.findUnique({
    where: { email },
    select: { id: true, name: true },
  });
  let userCreated = false;
  if (!user) {
    user = await db.user.create({
      data: { email, name, externalAuthId: `scim-${randomUUID()}` },
      select: { id: true, name: true },
    });
    userCreated = true;
  } else {
    const existingByUserId = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      select: { userId: true },
    });
    if (existingByUserId) {
      throw new ServiceError("CONFLICT", MEMBER_ALREADY_EXISTS);
    }
  }

  let membership: { createdAt: Date };
  try {
    membership = await db.organizationMember.create({
      data: {
        organizationId,
        userId: user.id,
        userEmail: email,
        role: "member",
        status: "active",
      },
      select: { createdAt: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError("CONFLICT", MEMBER_ALREADY_EXISTS);
    }
    throw err;
  }

  return {
    userId: user.id,
    email,
    name: user.name ?? name,
    role: "member",
    status: "active",
    ssoExempt: false,
    joinedAt: membership.createdAt.toISOString(),
    userCreated,
  };
};

export interface MemberStatusResult {
  userId: string;
  status: string;
  ssoExempt: boolean;
  revocation: RevocationOutcome;
}

/**
 * `PATCH /org/members/:userId { status: "suspended" }`. Guards run BEFORE any
 * write (a failed guard leaves no update and no revocation call). Revocation
 * is always `"skipped"` in this build — see the module doc.
 */
export const suspendMember = async (
  organizationId: string,
  targetUserId: string,
  actingUserId: string,
): Promise<MemberStatusResult> => {
  if (targetUserId === actingUserId) {
    throw new ServiceError("BAD_REQUEST", "You cannot suspend yourself");
  }

  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    select: { role: true, status: true, ssoExempt: true },
  });
  if (!membership) {
    throw new ServiceError(
      "NOT_FOUND",
      "User is not a member of this organization",
    );
  }
  if (membership.role === "owner") {
    throw new ServiceError(
      "BAD_REQUEST",
      "The organization owner cannot be suspended",
    );
  }
  if (membership.status === "suspended") {
    throw new ServiceError("CONFLICT", "This member is already suspended");
  }

  await db.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    data: { status: "suspended", suspendedAt: new Date() },
  });

  return {
    userId: targetUserId,
    status: "suspended",
    ssoExempt: membership.ssoExempt,
    revocation: "skipped",
  };
};

/**
 * `PATCH /org/members/:userId { status: "active" }`. The status flip lands
 * BEFORE any role-mapping reconciliation would run (ordering matters: a
 * suspended member is skipped by the reconciler) — there is no reconciler
 * wired in this phase, so this is a plain status flip.
 */
export const reinstateMember = async (
  organizationId: string,
  targetUserId: string,
): Promise<MemberStatusResult> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    select: { status: true, ssoExempt: true },
  });
  if (!membership) {
    throw new ServiceError(
      "NOT_FOUND",
      "User is not a member of this organization",
    );
  }
  if (membership.status !== "suspended") {
    throw new ServiceError("CONFLICT", "This member is not suspended");
  }

  await db.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    data: { status: "active", suspendedAt: null },
  });

  return {
    userId: targetUserId,
    status: "active",
    ssoExempt: membership.ssoExempt,
    revocation: "skipped",
  };
};

/** `PATCH /org/members/:userId { ssoExempt }`. */
export const setMemberSsoExempt = async (
  organizationId: string,
  targetUserId: string,
  ssoExempt: boolean,
): Promise<{ userId: string; status: string; ssoExempt: boolean }> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    select: { status: true },
  });
  if (!membership) {
    throw new ServiceError(
      "NOT_FOUND",
      "User is not a member of this organization",
    );
  }

  await db.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    data: { ssoExempt },
  });

  return { userId: targetUserId, status: membership.status, ssoExempt };
};

/**
 * `GET /org/members/:userId/groups`: the groups the user belongs to in this
 * org, same directory envelope as `/org/groups`. An unknown user or one
 * outside the org reads as an empty page, never a 404 — the `where` fragment
 * simply matches nothing.
 */
export const groupsFor = async (
  organizationId: string,
  userId: string,
  params: { limit?: number; cursor?: string } = {},
): Promise<DirectoryPage<GroupRow>> =>
  listGroupsPage({ organizationId, members: { some: { userId } } }, params);
