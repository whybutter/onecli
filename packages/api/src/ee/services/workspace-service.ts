import { db, type Prisma } from "@onecli/db";
import { customAlphabet } from "nanoid";
import { generateWorkspaceId } from "../../lib/ids";
import { invalidateGatewayCacheForKeys } from "../../lib/gateway-invalidate";
import { logger } from "../../lib/logger";
import type { OrgRole } from "../../providers/types";
import { ServiceError } from "../../services/errors";
import {
  activeMembershipWhere,
  defaultWorkspaceSeed,
  ensureWorkspaceSeeds,
  findUserDefaultWorkspace,
  slugify,
} from "../../services/organization-service";
import { teardownWorkspacePresences } from "../../services/channels/agent-channel-service";
import {
  DISPLAY_NAME_MIN_LEN,
  validateDisplayName,
} from "../../validations/display-name";
import { isUniqueViolation } from "../lib/prisma-errors";
import {
  canManageAllWorkspaces,
  visibleWorkspacesWhere,
} from "./authorization-service";

const log = logger.child({ component: "workspace-service" });

export interface WorkspaceOwner {
  name: string | null;
  email: string | null;
  isCurrentUser: boolean;
}

export interface WorkspaceListItem {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: Date;
  agentCount: number;
  resourceCount: number;
  owner: WorkspaceOwner | null;
  canManage: boolean;
}

export interface UserOrgWithWorkspaces {
  id: string;
  name: string;
  workspaces: { id: string; name: string | null }[];
}

/** The shape the `/v1/workspaces` router returns for a single workspace. */
const workspaceSelect = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
} satisfies Prisma.WorkspaceSelect;

const NOT_FOUND = () => new ServiceError("NOT_FOUND", "Workspace not found");

const slugConflict = (slug: string) =>
  new ServiceError(
    "CONFLICT",
    `A workspace with slug "${slug}" already exists`,
  );

/**
 * Run a write whose slug uniqueness was pre-checked; a concurrent writer that
 * wins the race between the check and the write surfaces as the same 409
 * the pre-check would have answered, never as a 500.
 */
const withSlugConflict = async <T>(slug: string, write: () => Promise<T>) => {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err)) throw slugConflict(slug);
    throw err;
  }
};

const randomSlugSuffix = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyz",
  6,
);

/**
 * The data block every user-created workspace is born from: the creator's
 * personal API key and their owner-role access binding, in the same nested
 * create as the row itself, so neither can be missing.
 */
const newWorkspaceData = (
  organizationId: string,
  userId: string,
  userEmail: string,
  name: string,
  slug: string,
) => ({
  id: generateWorkspaceId(),
  name,
  slug,
  organizationId,
  createdByUserId: userId,
  createdByUserEmail: userEmail,
  ...defaultWorkspaceSeed(userId, userEmail),
  accessBindings: { create: { userId, role: "owner" } },
});

// ─── Dashboard reads ──────────────────────────────────────────────────────────

/**
 * Every dashboard load: make sure each workspace the user created in their
 * active organizations carries their personal API key, then answer their
 * default workspace (or null — this never creates an organization; the
 * session route's bootstrap does).
 */
export const ensureUserDefaultOrgAndWorkspace = async (
  userId: string,
  userEmail: string,
): Promise<{ id: string; organizationId: string } | null> => {
  const created = await db.workspace.findMany({
    where: {
      createdByUserId: userId,
      organization: {
        members: { some: { userId, ...activeMembershipWhere } },
      },
    },
    select: { id: true },
  });
  for (const workspace of created) {
    await ensureWorkspaceSeeds(workspace.id, userId, userEmail);
  }
  return findUserDefaultWorkspace(userId);
};

const countByOrg = (
  rows: { organizationId: string | null; _count: { _all: number } }[],
) => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.organizationId) counts.set(row.organizationId, row._count._all);
  }
  return counts;
};

/**
 * The workspaces page: what the viewer can see, with the counts the cards
 * render. `resourceCount` is the workspace's own secrets and connected
 * connections plus the org-scoped ones every workspace in the org inherits
 * (the org aggregates are computed once per org, three queries in total).
 * `canManage` is org owner/admin, or the viewer's own owner-role binding.
 */
export const listWorkspaces = async (
  userId: string,
  organizationId?: string,
  role?: OrgRole | null,
): Promise<WorkspaceListItem[]> => {
  const isOrgManager = organizationId
    ? canManageAllWorkspaces(role ?? null)
    : false;
  const where: Prisma.WorkspaceWhereInput = organizationId
    ? visibleWorkspacesWhere(userId, organizationId, role ?? null)
    : // Defensive fallback without an org: every active-membership org,
      // bindings-only (no creator arm).
      {
        organization: {
          members: { some: { userId, ...activeMembershipWhere } },
        },
        accessBindings: { some: { userId } },
      };

  const rows = await db.workspace.findMany({
    where,
    select: {
      ...workspaceSelect,
      organizationId: true,
      createdByUserId: true,
      createdByUserEmail: true,
      createdByUser: { select: { name: true, email: true } },
      accessBindings: {
        where: { userId, role: "owner" },
        select: { id: true },
      },
      _count: {
        select: {
          agents: true,
          secrets: true,
          appConnections: { where: { status: "connected" } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const orgIds = [...new Set(rows.map((row) => row.organizationId))];
  const [orgSecrets, orgConnections] =
    orgIds.length === 0
      ? [[], []]
      : await Promise.all([
          db.secret.groupBy({
            by: ["organizationId"],
            where: { scope: "organization", organizationId: { in: orgIds } },
            _count: { _all: true },
          }),
          db.appConnection.groupBy({
            by: ["organizationId"],
            where: {
              scope: "organization",
              organizationId: { in: orgIds },
              status: "connected",
            },
            _count: { _all: true },
          }),
        ]);
  const orgSecretCounts = countByOrg(orgSecrets);
  const orgConnectionCounts = countByOrg(orgConnections);

  return rows.map((row) => {
    const ownerEmail = row.createdByUser?.email ?? row.createdByUserEmail;
    const owner: WorkspaceOwner | null =
      row.createdByUserId || ownerEmail
        ? {
            name: row.createdByUser?.name ?? null,
            email: ownerEmail ?? null,
            isCurrentUser: row.createdByUserId === userId,
          }
        : null;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt,
      agentCount: row._count.agents,
      resourceCount:
        row._count.secrets +
        row._count.appConnections +
        (orgSecretCounts.get(row.organizationId) ?? 0) +
        (orgConnectionCounts.get(row.organizationId) ?? 0),
      owner,
      canManage: isOrgManager || row.accessBindings.length > 0,
    };
  });
};

/**
 * The CLI device-auth confirm screen: the user's active organizations,
 * oldest first, each with the workspaces they CREATED there.
 */
export const getUserOrgsWithWorkspaces = async (
  userId: string,
): Promise<UserOrgWithWorkspaces[]> => {
  const memberships = await db.organizationMember.findMany({
    where: { userId, ...activeMembershipWhere },
    orderBy: { createdAt: "asc" },
    select: { organization: { select: { id: true, name: true } } },
  });
  if (memberships.length === 0) return [];

  const workspaces = await db.workspace.findMany({
    where: {
      createdByUserId: userId,
      organizationId: { in: memberships.map((m) => m.organization.id) },
    },
    select: { id: true, name: true, organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map(({ organization }) => ({
    id: organization.id,
    name: organization.name,
    workspaces: workspaces
      .filter((workspace) => workspace.organizationId === organization.id)
      .map(({ id, name }) => ({ id, name })),
  }));
};

// ─── Web create ───────────────────────────────────────────────────────────────

/**
 * The web "new workspace" action. The name must pass the display-name rules
 * (2–50 characters with a letter or digit; plain `Error`s, the action layer
 * surfaces them as-is). The slug is the slugified name plus a random suffix,
 * so two same-named workspaces in one org never collide. Creates the row,
 * the creator's API key and their owner binding atomically.
 */
export const createWorkspace = async (
  userId: string,
  userEmail: string,
  rawName: string,
  organizationId: string,
): Promise<{ id: string; name: string | null; slug: string | null }> => {
  const name = rawName.trim();
  // `validateDisplayName("")` is null by design (an optional field left
  // blank), so emptiness is refused here in the validator's own words.
  const problem = name
    ? validateDisplayName(name)
    : `At least ${DISPLAY_NAME_MIN_LEN} characters`;
  if (problem) throw new Error(problem);

  const slug = `${slugify(name) || "workspace"}-${randomSlugSuffix()}`;
  return db.workspace.create({
    data: newWorkspaceData(organizationId, userId, userEmail, name, slug),
    select: { id: true, name: true, slug: true },
  });
};

// ─── The /v1/workspaces router ────────────────────────────────────────────────

/** Visibility-fenced list for the org the caller authenticated against. */
export const listOrgWorkspacesForUser = async (
  userId: string,
  organizationId: string,
  role: OrgRole | null,
) =>
  db.workspace.findMany({
    where: visibleWorkspacesWhere(userId, organizationId, role),
    select: workspaceSelect,
    orderBy: { createdAt: "asc" },
  });

/** Every workspace in the org — unfenced, for admin callers only. */
export const listOrgWorkspaces = async (organizationId: string) =>
  db.workspace.findMany({
    where: { organizationId },
    select: workspaceSelect,
    orderBy: { createdAt: "asc" },
  });

/** Visibility-fenced single read: an unseen workspace is a 404, never a 403. */
export const getWorkspaceById = async (
  userId: string,
  organizationId: string,
  targetId: string,
  role: OrgRole | null,
) => {
  const workspace = await db.workspace.findFirst({
    where: {
      id: targetId,
      ...visibleWorkspacesWhere(userId, organizationId, role),
    },
    select: workspaceSelect,
  });
  if (!workspace) throw NOT_FOUND();
  return workspace;
};

/**
 * `POST /workspaces` (org admins): the headless provisioning door. The slug
 * is derived from the name and must be unique in the org (409 otherwise);
 * the creator's personal key comes back raw so a script can use it at once.
 */
export const createOrgWorkspace = async (
  organizationId: string,
  userId: string,
  input: { name: string },
) => {
  const name = input.name.trim();
  const slug = slugify(name) || "workspace";

  const existing = await db.workspace.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
    select: { id: true },
  });
  if (existing) throw slugConflict(slug);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new ServiceError("NOT_FOUND", "User not found");

  // The creator's key is seeded in the same nested create as the row, so it
  // is read back from that write rather than minted and looked up again.
  const { apiKeys, ...workspace } = await withSlugConflict(slug, () =>
    db.workspace.create({
      data: newWorkspaceData(organizationId, userId, user.email, name, slug),
      select: { ...workspaceSelect, apiKeys: { select: { key: true } } },
    }),
  );
  return { ...workspace, apiKey: apiKeys[0]?.key ?? null };
};

/** `PATCH /workspaces/:id`: rename; the slug follows the name. */
export const updateOrgWorkspace = async (
  organizationId: string,
  targetId: string,
  input: { name?: string },
) => {
  const current = await db.workspace.findFirst({
    where: { id: targetId, organizationId },
    select: workspaceSelect,
  });
  if (!current) throw NOT_FOUND();
  if (input.name === undefined) return current;

  const name = input.name.trim();
  const slug = slugify(name) || "workspace";
  const conflict = await db.workspace.findFirst({
    where: { organizationId, slug, NOT: { id: targetId } },
    select: { id: true },
  });
  if (conflict) throw slugConflict(slug);

  return withSlugConflict(slug, () =>
    db.workspace.update({
      where: { id: targetId },
      data: { name, slug },
      select: workspaceSelect,
    }),
  );
};

/**
 * `DELETE /workspaces/:id`: the org must keep at least one workspace (the
 * same guard the workspaces list and the settings page apply).
 */
export const deleteOrgWorkspace = async (
  organizationId: string,
  targetId: string,
): Promise<void> => {
  const workspace = await db.workspace.findFirst({
    where: { id: targetId, organizationId },
    select: { id: true },
  });
  if (!workspace) throw NOT_FOUND();

  const count = await db.workspace.count({ where: { organizationId } });
  if (count <= 1) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Cannot delete the only workspace in the organization",
    );
  }
  await deleteWorkspace(targetId);
};

// ─── Deletion ─────────────────────────────────────────────────────────────────

/**
 * The hand-written workspace cascade, inside the caller's transaction.
 * Children whose foreign keys are Restrict (agents, vault connections,
 * onboarding surveys, workspace-tier skills) are deleted explicitly, in
 * dependency order; agent-tier rows cascade from their agent, policy rules
 * and access bindings cascade from the workspace row. Request logs carry no
 * foreign key and are swept by workspace id.
 */
export const deleteWorkspaceContent = async (
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> => {
  await tx.requestLog.deleteMany({ where: { workspaceId } });
  await tx.skill.deleteMany({ where: { workspaceId } });
  await tx.agent.deleteMany({ where: { workspaceId } });
  await tx.appConnection.deleteMany({ where: { workspaceId } });
  await tx.secret.deleteMany({ where: { workspaceId } });
  await tx.appConfig.deleteMany({ where: { workspaceId } });
  await tx.vaultConnection.deleteMany({ where: { workspaceId } });
  await tx.onboardingSurvey.deleteMany({ where: { workspaceId } });
  await tx.auditLog.deleteMany({ where: { workspaceId } });
  await tx.apiKey.deleteMany({ where: { workspaceId } });
  await tx.workspace.delete({ where: { id: workspaceId } });
};

/**
 * Delete a workspace and everything in it.
 *
 * 1. Best-effort provider-side teardown of channel presences, OUTSIDE the
 *    transaction (network calls never belong inside one).
 * 2. One transaction: capture the workspace's API keys, then the cascade.
 * 3. After the commit, flush the gateway cache for exactly those keys — an
 *    org-wide flush could no longer find them.
 */
export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  try {
    await teardownWorkspacePresences(workspaceId);
  } catch (err) {
    log.warn(
      { err, workspaceId },
      "channel presence teardown failed during workspace deletion; continuing",
    );
  }

  const keys = await db.$transaction(async (tx) => {
    const apiKeys = await tx.apiKey.findMany({
      where: { workspaceId },
      select: { key: true },
    });
    await deleteWorkspaceContent(workspaceId, tx);
    return apiKeys.map((row) => row.key);
  });

  invalidateGatewayCacheForKeys(keys);
};
