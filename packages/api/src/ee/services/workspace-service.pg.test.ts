import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The rebuilt workspace, authorization and team services on REAL PostgreSQL.
 *
 * The vitest doubles pin the decision logic; what only a database can prove
 * is that the Prisma query SHAPES are valid — the filtered relation counts
 * and org group-bys behind `listWorkspaces`, the nested membership fence, the
 * "no other binding" negation behind the personal-workspace set, and the
 * hand-written cascades (Restrict foreign keys fail loudly when a child is
 * forgotten). Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type WorkspaceService = typeof import("./workspace-service");
type AuthorizationService = typeof import("./authorization-service");
type TeamService = typeof import("./team-service");

let db: Db;
let workspaces: WorkspaceService;
let authz: AuthorizationService;
let team: TeamService;

const P = "wp3-";
const ORG = `${P}org`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const OWNER_EMAIL = `${OWNER}@example.invalid`;
const MEMBER_EMAIL = `${MEMBER}@example.invalid`;

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";

  ({ db } = await import("@onecli/db"));
  workspaces = await import("./workspace-service");
  authz = await import("./authorization-service");
  team = await import("./team-service");
  await resetAll();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await resetAll();
});

const resetAll = async () => {
  const rows = await db.workspace.findMany({
    where: { organizationId: ORG },
    select: { id: true },
  });
  const ids = rows.map((row) => row.id);
  await db.agent.deleteMany({ where: { workspaceId: { in: ids } } });
  await db.apiKey.deleteMany({
    where: { OR: [{ workspaceId: { in: ids } }, { organizationId: ORG }] },
  });
  await db.secret.deleteMany({
    where: { OR: [{ workspaceId: { in: ids } }, { organizationId: ORG }] },
  });
  await db.appConnection.deleteMany({
    where: { OR: [{ workspaceId: { in: ids } }, { organizationId: ORG }] },
  });
  await db.auditLog.deleteMany({
    where: { OR: [{ workspaceId: { in: ids } }, { organizationId: ORG }] },
  });
  await db.workspace.deleteMany({ where: { organizationId: ORG } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { in: [OWNER, MEMBER] } } });
};

beforeEach(async () => {
  if (!PROOF_URL) return;
  await resetAll();
  await db.user.create({
    data: { id: OWNER, email: OWNER_EMAIL, externalAuthId: `${P}auth-owner` },
  });
  await db.user.create({
    data: {
      id: MEMBER,
      email: MEMBER_EMAIL,
      externalAuthId: `${P}auth-member`,
    },
  });
  await db.organization.create({
    data: {
      id: ORG,
      name: "WP3 Org",
      slug: ORG,
      members: {
        create: [
          { userId: OWNER, userEmail: OWNER_EMAIL, role: "owner" },
          { userId: MEMBER, userEmail: MEMBER_EMAIL, role: "member" },
        ],
      },
    },
  });
});

describe.skipIf(!PROOF_URL)("workspace service on PostgreSQL", () => {
  it("createWorkspace seeds the key and the owner binding; the creator can manage", async () => {
    const created = await workspaces.createWorkspace(
      MEMBER,
      MEMBER_EMAIL,
      "Member Space",
      ORG,
    );
    expect(created.slug).toMatch(/^member-space-[0-9a-z]{6}$/);
    await expect(
      db.workspaceAccess.findMany({ where: { workspaceId: created.id } }),
    ).resolves.toMatchObject([{ userId: MEMBER, role: "owner" }]);
    await expect(
      db.apiKey.count({ where: { workspaceId: created.id, userId: MEMBER } }),
    ).resolves.toBe(1);
    await expect(authz.canManageWorkspace(MEMBER, created.id)).resolves.toBe(
      true,
    );
    await expect(authz.canAccessWorkspace(OWNER, created.id)).resolves.toBe(
      true,
    );
  });

  it("listWorkspaces: counts, inherited org resources, owner and canManage", async () => {
    const mine = await workspaces.createWorkspace(
      MEMBER,
      MEMBER_EMAIL,
      "Mine",
      ORG,
    );
    const theirs = await workspaces.createWorkspace(
      OWNER,
      OWNER_EMAIL,
      "Theirs",
      ORG,
    );
    await db.agent.create({
      data: {
        workspaceId: mine.id,
        name: "a",
        identifier: `${P}agent`,
        accessToken: `aoc_${P}token`,
      },
    });
    await db.secret.create({
      data: {
        workspaceId: mine.id,
        name: "s",
        type: "generic",
        hostPattern: "example.invalid",
      },
    });
    await db.secret.create({
      data: {
        scope: "organization",
        organizationId: ORG,
        name: "org-s",
        type: "generic",
        hostPattern: "example.invalid",
      },
    });
    await db.appConnection.create({
      data: {
        scope: "organization",
        organizationId: ORG,
        provider: "github",
        status: "connected",
      },
    });
    await db.appConnection.create({
      data: { workspaceId: theirs.id, provider: "github", status: "revoked" },
    });

    const forMember = await workspaces.listWorkspaces(MEMBER, ORG, "member");
    expect(forMember.map((w) => w.id)).toEqual([mine.id]);
    expect(forMember[0]).toMatchObject({
      agentCount: 1,
      // own secret + org secret + org connection (the revoked one is theirs
      // and not connected anyway)
      resourceCount: 3,
      owner: { email: MEMBER_EMAIL, isCurrentUser: true },
      canManage: true,
    });

    const forOwner = await workspaces.listWorkspaces(OWNER, ORG, "owner");
    expect(forOwner.map((w) => w.id).sort()).toEqual(
      [mine.id, theirs.id].sort(),
    );
    const theirsRow = forOwner.find((w) => w.id === theirs.id)!;
    expect(theirsRow).toMatchObject({
      agentCount: 0,
      resourceCount: 2,
      owner: { email: OWNER_EMAIL, isCurrentUser: true },
      canManage: true,
    });
    const mineRow = forOwner.find((w) => w.id === mine.id)!;
    expect(mineRow.owner).toMatchObject({ isCurrentUser: false });
  });

  it("the /v1/workspaces reads fence by visibility and the CLI picker groups by org", async () => {
    const mine = await workspaces.createWorkspace(
      MEMBER,
      MEMBER_EMAIL,
      "Mine",
      ORG,
    );
    const theirs = await workspaces.createOrgWorkspace(ORG, OWNER, {
      name: "Theirs",
    });
    expect(theirs.apiKey).toMatch(/^oc_/);

    await expect(
      workspaces.getWorkspaceById(MEMBER, ORG, theirs.id, "member"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      workspaces.getWorkspaceById(OWNER, ORG, mine.id, "owner"),
    ).resolves.toMatchObject({ id: mine.id });
    await expect(workspaces.getUserOrgsWithWorkspaces(MEMBER)).resolves.toEqual(
      [
        {
          id: ORG,
          name: "WP3 Org",
          workspaces: [{ id: mine.id, name: "Mine" }],
        },
      ],
    );
    await expect(
      workspaces.ensureUserDefaultOrgAndWorkspace(MEMBER, MEMBER_EMAIL),
    ).resolves.toEqual({ id: mine.id, organizationId: ORG });
  });

  it("the checker denies a suspended member and admits an admin", async () => {
    const mine = await workspaces.createWorkspace(
      MEMBER,
      MEMBER_EMAIL,
      "Mine",
      ORG,
    );
    const ref = { id: mine.id, organizationId: ORG };
    await expect(
      authz.eeWorkspaceAccessChecker.canAccessWorkspaceAsUser(MEMBER, ref),
    ).resolves.toBe(true);
    await db.organizationMember.update({
      where: { organizationId_userId: { organizationId: ORG, userId: MEMBER } },
      data: { status: "suspended" },
    });
    await expect(authz.getUserRole(MEMBER, ORG)).resolves.toBeNull();
    await expect(
      authz.eeWorkspaceAccessChecker.canAccessWorkspaceAsUser(MEMBER, ref),
    ).resolves.toBe(false);
    await expect(authz.canAccessWorkspace(MEMBER, mine.id)).resolves.toBe(
      false,
    );
    await expect(
      authz.eeWorkspaceAccessChecker.userIsOrgAdmin(OWNER, ORG),
    ).resolves.toBe(true);
  });

  it("removeMember deletes only the truly-personal workspaces, then the membership", async () => {
    const personal = await workspaces.createWorkspace(
      MEMBER,
      MEMBER_EMAIL,
      "Personal",
      ORG,
    );
    const shared = await workspaces.createWorkspace(
      MEMBER,
      MEMBER_EMAIL,
      "Shared",
      ORG,
    );
    await db.workspaceAccess.create({
      data: { workspaceId: shared.id, userId: OWNER, role: "member" },
    });
    await db.agent.create({
      data: {
        workspaceId: personal.id,
        name: "a",
        identifier: `${P}agent-personal`,
        accessToken: `aoc_${P}token-personal`,
      },
    });

    await expect(
      team.findDeletablePersonalWorkspaces(ORG, MEMBER),
    ).resolves.toEqual([
      { id: personal.id, name: "Personal", channelApps: [] },
    ]);
    await expect(team.listMembers(ORG)).resolves.toMatchObject([
      { userId: OWNER, role: "owner", roleManagedByIdp: false },
      { userId: MEMBER, role: "member", roleManagedByIdp: false },
    ]);

    await expect(
      team.removeMember(ORG, MEMBER, { revokeIdentity: false }),
    ).resolves.toBe("skipped");

    const remaining = await db.workspace.findMany({
      where: { organizationId: ORG },
      select: { id: true },
    });
    expect(remaining.map((w) => w.id)).toEqual([shared.id]);
    await expect(
      db.workspaceAccess.count({ where: { userId: MEMBER } }),
    ).resolves.toBe(0);
    await expect(
      db.apiKey.count({ where: { userId: MEMBER, workspaceId: shared.id } }),
    ).resolves.toBe(0);
    await expect(authz.getUserRole(MEMBER, ORG)).resolves.toBeNull();
    await expect(team.removeMember(ORG, OWNER)).rejects.toThrow(
      "The organization owner cannot be removed",
    );
  });

  it("deleteOrgWorkspace keeps the last workspace and cascades the rest", async () => {
    const a = await workspaces.createWorkspace(
      OWNER,
      OWNER_EMAIL,
      "Alpha",
      ORG,
    );
    const b = await workspaces.createWorkspace(OWNER, OWNER_EMAIL, "Beta", ORG);
    await db.agent.create({
      data: {
        workspaceId: b.id,
        name: "a",
        identifier: `${P}agent-b`,
        accessToken: `aoc_${P}token-b`,
      },
    });
    await workspaces.deleteOrgWorkspace(ORG, b.id);
    await expect(
      db.workspace.count({ where: { organizationId: ORG } }),
    ).resolves.toBe(1);
    await expect(
      workspaces.deleteOrgWorkspace(ORG, a.id),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
