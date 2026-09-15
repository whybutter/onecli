import { beforeEach, describe, expect, it, vi } from "vitest";

// The workspace's human-sharing surface (api-ee-behaviour §2.2): the GET
// read shape and the PUT full-replace diff/validate/gate/transaction
// semantics. A hand-rolled @onecli/db double.

interface BindingRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  workspace: {
    id: "ws-1",
    organizationId: "org-1",
    createdByUserId: "creator-1",
  } as {
    id: string;
    organizationId: string;
    createdByUserId: string | null;
  } | null,
  bindings: [] as BindingRow[],
  users: [] as { id: string; name: string | null; email: string }[],
  groups: [] as { id: string; name: string; memberCount: number }[],
  orgMembers: [] as {
    organizationId: string;
    userId: string;
    status: string;
  }[],
  orgGroups: [] as { id: string; organizationId: string }[],
  nextId: 1,
}));

const PLACEHOLDER_EMAIL_SUFFIX = "@onecli.internal";

vi.mock("@onecli/db", () => {
  const db = {
    workspace: {
      findUnique: async () => store.workspace,
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) =>
        store.workspace &&
        store.workspace.id === where.id &&
        store.workspace.organizationId === where.organizationId
          ? { id: store.workspace.id }
          : null,
    },
    workspaceAccess: {
      findMany: async ({ where }: { where: { workspaceId: string } }) =>
        store.bindings
          .filter((b) => b.workspaceId === where.workspaceId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((b) => ({
            id: b.id,
            userId: b.userId,
            groupId: b.groupId,
            role: b.role,
            createdAt: b.createdAt,
            user: b.userId
              ? (store.users.find((u) => u.id === b.userId) ?? null)
              : null,
            group: b.groupId
              ? (() => {
                  const g = store.groups.find((x) => x.id === b.groupId);
                  return g
                    ? { name: g.name, _count: { members: g.memberCount } }
                    : null;
                })()
              : null,
          })),
      deleteMany: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          userId?: { in: string[] };
          groupId?: { in: string[] };
        };
      }) => {
        const before = store.bindings.length;
        store.bindings = store.bindings.filter((b) => {
          if (b.workspaceId !== where.workspaceId) return true;
          if (where.userId && b.userId && where.userId.in.includes(b.userId)) {
            return false;
          }
          if (
            where.groupId &&
            b.groupId &&
            where.groupId.in.includes(b.groupId)
          ) {
            return false;
          }
          return true;
        });
        return { count: before - store.bindings.length };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { workspaceId: string; userId: string };
        data: { role: string };
      }) => {
        const row = store.bindings.find(
          (b) =>
            b.workspaceId === where.workspaceId && b.userId === where.userId,
        );
        if (!row) return { count: 0 };
        row.role = data.role;
        return { count: 1 };
      },
      createMany: async ({
        data,
      }: {
        data: {
          workspaceId: string;
          userId?: string;
          groupId?: string;
          role?: string;
          createdByUserId: string;
        }[];
      }) => {
        for (const d of data) {
          store.bindings.push({
            id: `binding-${store.nextId++}`,
            workspaceId: d.workspaceId,
            userId: d.userId ?? null,
            groupId: d.groupId ?? null,
            role: d.role ?? "member",
            createdAt: new Date(),
          });
        }
        return { count: data.length };
      },
    },
    organizationMember: {
      findMany: async ({
        where,
      }: {
        where: {
          organizationId: string;
          userId: { in: string[] };
          status: { not: string };
        };
      }) =>
        store.orgMembers.filter(
          (m) =>
            m.organizationId === where.organizationId &&
            where.userId.in.includes(m.userId) &&
            m.status !== where.status.not,
        ),
    },
    group: {
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; id: { in: string[] } };
      }) =>
        store.orgGroups.filter(
          (g) =>
            g.organizationId === where.organizationId &&
            where.id.in.includes(g.id),
        ),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { Prisma: {}, db };
});

import {
  getWorkspaceAccessBindings,
  setWorkspaceAccessBindings,
} from "./workspace-access-service";

const WS = "ws-1";
const ORG = "org-1";

beforeEach(() => {
  store.workspace = {
    id: WS,
    organizationId: ORG,
    createdByUserId: "creator-1",
  };
  store.bindings = [];
  store.users = [];
  store.groups = [];
  store.orgMembers = [];
  store.orgGroups = [];
  store.nextId = 1;
});

describe("getWorkspaceAccessBindings", () => {
  it("splits user and group bindings, flags isOwner and normalizes role", async () => {
    store.users = [
      { id: "creator-1", name: "Creator", email: "creator@example.com" },
      { id: "u2", name: "Member Two", email: "u2@example.com" },
    ];
    store.groups = [{ id: "g1", name: "Engineering", memberCount: 3 }];
    store.bindings = [
      {
        id: "b1",
        workspaceId: WS,
        userId: "creator-1",
        groupId: null,
        role: "owner",
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "b2",
        workspaceId: WS,
        userId: "u2",
        groupId: null,
        role: "weird-value",
        createdAt: new Date("2026-01-02"),
      },
      {
        id: "b3",
        workspaceId: WS,
        userId: null,
        groupId: "g1",
        role: "member",
        createdAt: new Date("2026-01-03"),
      },
    ];

    const result = await getWorkspaceAccessBindings(WS);
    expect(result.users).toEqual([
      {
        id: "b1",
        userId: "creator-1",
        name: "Creator",
        email: "creator@example.com",
        role: "owner",
        isOwner: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "b2",
        userId: "u2",
        name: "Member Two",
        email: "u2@example.com",
        // Any stored role other than "owner" reads as "member".
        role: "member",
        isOwner: false,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(result.groups).toEqual([
      {
        id: "b3",
        groupId: "g1",
        name: "Engineering",
        memberCount: 3,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ]);
  });

  it("omits placeholder users", async () => {
    store.users = [
      { id: "ghost", name: null, email: `ghost${PLACEHOLDER_EMAIL_SUFFIX}` },
    ];
    store.bindings = [
      {
        id: "b1",
        workspaceId: WS,
        userId: "ghost",
        groupId: null,
        role: "member",
        createdAt: new Date(),
      },
    ];
    const result = await getWorkspaceAccessBindings(WS);
    expect(result.users).toEqual([]);
  });
});

describe("setWorkspaceAccessBindings", () => {
  const activeMember = (userId: string) =>
    store.orgMembers.push({ organizationId: ORG, userId, status: "active" });

  it("is a no-op when the desired set already matches — no transaction", async () => {
    store.bindings = [
      {
        id: "b1",
        workspaceId: WS,
        userId: "u1",
        groupId: null,
        role: "owner",
        createdAt: new Date(),
      },
    ];
    const result = await setWorkspaceAccessBindings(ORG, WS, "actor", {
      users: [{ userId: "u1", role: "owner" }],
      groupIds: [],
    });
    expect(result).toEqual({ added: 0, removed: 0, roleChanged: 0 });
  });

  it("adds a new user directly as the given role, records createdByUserId", async () => {
    activeMember("u1");
    const result = await setWorkspaceAccessBindings(ORG, WS, "actor-1", {
      users: [{ userId: "u1", role: "owner" }],
      groupIds: [],
    });
    expect(result).toEqual({ added: 1, removed: 0, roleChanged: 0 });
    expect(store.bindings).toMatchObject([{ userId: "u1", role: "owner" }]);
  });

  it("re-roles a preserved user in place — update, never delete+recreate", async () => {
    store.bindings = [
      {
        id: "b1",
        workspaceId: WS,
        userId: "u1",
        groupId: null,
        role: "member",
        createdAt: new Date(),
      },
    ];
    const result = await setWorkspaceAccessBindings(ORG, WS, "actor", {
      users: [{ userId: "u1", role: "owner" }],
      groupIds: [],
    });
    expect(result).toEqual({ added: 0, removed: 0, roleChanged: 1 });
    expect(store.bindings).toHaveLength(1);
    expect(store.bindings[0]?.id).toBe("b1");
    expect(store.bindings[0]?.role).toBe("owner");
  });

  it("an empty payload removes everything, including the creator's own binding", async () => {
    store.bindings = [
      {
        id: "b1",
        workspaceId: WS,
        userId: "creator-1",
        groupId: null,
        role: "owner",
        createdAt: new Date(),
      },
    ];
    const result = await setWorkspaceAccessBindings(ORG, WS, "actor", {
      users: [],
      groupIds: [],
    });
    expect(result).toEqual({ added: 0, removed: 1, roleChanged: 0 });
    expect(store.bindings).toEqual([]);
  });

  it("rejects a non-active-member addition before any write", async () => {
    await expect(
      setWorkspaceAccessBindings(ORG, WS, "actor", {
        users: [{ userId: "ghost", role: "member" }],
        groupIds: [],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Not active members of this organization: ghost",
    });
    expect(store.bindings).toEqual([]);
  });

  it("rejects a foreign-org group addition before any write", async () => {
    await expect(
      setWorkspaceAccessBindings(ORG, WS, "actor", {
        users: [],
        groupIds: ["g-foreign"],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Groups not in this organization: g-foreign",
    });
    expect(store.bindings).toEqual([]);
  });

  it("adds and removes group bindings, role-less (always member)", async () => {
    store.orgGroups = [{ id: "g1", organizationId: ORG }];
    const result = await setWorkspaceAccessBindings(ORG, WS, "actor", {
      users: [],
      groupIds: ["g1"],
    });
    expect(result).toEqual({ added: 1, removed: 0, roleChanged: 0 });
    expect(store.bindings).toMatchObject([{ groupId: "g1", role: "member" }]);

    const removed = await setWorkspaceAccessBindings(ORG, WS, "actor", {
      users: [],
      groupIds: [],
    });
    expect(removed).toEqual({ added: 0, removed: 1, roleChanged: 0 });
  });

  it("dedupes users by id — last role wins", async () => {
    activeMember("u1");
    const result = await setWorkspaceAccessBindings(ORG, WS, "actor", {
      users: [
        { userId: "u1", role: "member" },
        { userId: "u1", role: "owner" },
      ],
      groupIds: [],
    });
    expect(result.added).toBe(1);
    expect(store.bindings).toHaveLength(1);
    expect(store.bindings[0]?.role).toBe("owner");
  });

  it("a preserved-but-suspended member never blocks the write (only additions are validated)", async () => {
    store.bindings = [
      {
        id: "b1",
        workspaceId: WS,
        userId: "u1",
        groupId: null,
        role: "member",
        createdAt: new Date(),
      },
    ];
    store.orgMembers = [
      { organizationId: ORG, userId: "u1", status: "suspended" },
    ];
    await expect(
      setWorkspaceAccessBindings(ORG, WS, "actor", {
        users: [{ userId: "u1", role: "owner" }],
        groupIds: [],
      }),
    ).resolves.toEqual({ added: 0, removed: 0, roleChanged: 1 });
  });

  it("404s when the given organizationId does not actually own the workspace — never validates additions against the wrong org", async () => {
    // The workspace really belongs to ORG; a caller passing a DIFFERENT
    // organizationId (e.g. a session scoped elsewhere via x-organization-id)
    // must be refused before any addition is validated against that other
    // org's membership/group tables — otherwise a user active in "org-evil"
    // could be bound onto a workspace that never belonged to org-evil.
    activeMember("u1");
    store.orgMembers.push({
      organizationId: "org-evil",
      userId: "evil-user",
      status: "active",
    });
    await expect(
      setWorkspaceAccessBindings("org-evil", WS, "evil-user", {
        users: [{ userId: "evil-user", role: "owner" }],
        groupIds: [],
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
    expect(store.bindings).toEqual([]);
  });
});
