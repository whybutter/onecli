import { beforeEach, describe, expect, it, vi } from "vitest";

// The service-level contract behind the /v1/workspaces router and the web
// actions (api-ee-behaviour §3.2): name rules and the seeded owner binding on
// create, slug conflicts, visibility fencing (an unseen workspace is a 404),
// the only-workspace delete guard, and the keys-then-cascade delete order.
// The route-level twin (`routes/workspaces.test.ts`) drives the same service
// through the real middleware chain.

interface WorkspaceRow {
  id: string;
  name: string | null;
  slug: string | null;
  organizationId: string;
  createdByUserId: string | null;
  createdAt: Date;
  accessBindings?: unknown;
}

const store = vi.hoisted(() => ({
  workspaces: [] as WorkspaceRow[],
  // When set, the next workspace create/update throws Prisma's unique
  // violation — the concurrent same-slug writer that wins the race between
  // the pre-check and the write.
  uniqueViolationOnNextWrite: false,
  bindings: [] as { workspaceId: string; userId: string }[],
  apiKeys: [] as { key: string; userId: string; workspaceId: string }[],
  deleted: [] as string[],
  flushed: [] as string[],
}));

vi.mock("@onecli/db", () => {
  type Where = {
    id?: string;
    organizationId?: string;
    slug?: string;
    NOT?: { id?: string };
    // `visibleWorkspacesWhere`'s member arm: a direct binding OR a group
    // binding (the group arm is exercised by `authorization-service.test.ts`
    // and the pg proof; this double only fixtures direct bindings, so the OR's
    // first branch is the one that ever matches here).
    accessBindings?: { some: { OR: [{ userId: string }, unknown] } };
  };
  const matches = (row: WorkspaceRow, where: Where) =>
    (where.id === undefined || row.id === where.id) &&
    (where.organizationId === undefined ||
      row.organizationId === where.organizationId) &&
    (where.slug === undefined || row.slug === where.slug) &&
    (where.NOT?.id === undefined || row.id !== where.NOT.id) &&
    (where.accessBindings === undefined ||
      store.bindings.some(
        (b) =>
          b.workspaceId === row.id &&
          b.userId === where.accessBindings!.some.OR[0].userId,
      ));
  const pick = (row: WorkspaceRow, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(
          Object.keys(select)
            .filter((k) => select[k])
            .map((k) => [k, row[k as keyof WorkspaceRow]]),
        )
      : row;
  const workspace = {
    findMany: async ({
      where,
      select,
    }: {
      where: Where;
      select?: Record<string, boolean>;
    }) =>
      store.workspaces
        .filter((w) => matches(w, where))
        .map((w) => pick(w, select)),
    findFirst: async ({
      where,
      select,
    }: {
      where: Where;
      select?: Record<string, boolean>;
    }) => {
      const row = store.workspaces.find((w) => matches(w, where));
      return row ? pick(row, select) : null;
    },
    findUnique: async ({
      where,
    }: {
      where: { organizationId_slug: { organizationId: string; slug: string } };
    }) =>
      store.workspaces.find(
        (w) =>
          w.organizationId === where.organizationId_slug.organizationId &&
          w.slug === where.organizationId_slug.slug,
      ) ?? null,
    create: async ({
      data,
      select,
    }: {
      data: Omit<WorkspaceRow, "createdAt"> & {
        apiKeys?: { create: { key: string; userId: string } };
      };
      select?: Record<string, boolean>;
    }) => {
      if (store.uniqueViolationOnNextWrite) {
        store.uniqueViolationOnNextWrite = false;
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        });
      }
      const { apiKeys, ...rest } = data;
      const row = { ...rest, createdAt: new Date() };
      store.workspaces.push(row);
      // Materialize the nested key seed the way the database would.
      if (apiKeys?.create) {
        store.apiKeys.push({ ...apiKeys.create, workspaceId: row.id });
      }
      const picked = pick(row, select) as Record<string, unknown>;
      if (select?.apiKeys) {
        picked.apiKeys = store.apiKeys
          .filter((k) => k.workspaceId === row.id)
          .map((k) => ({ key: k.key }));
      }
      return picked;
    },
    update: async ({
      where,
      data,
      select,
    }: {
      where: { id: string };
      data: Partial<WorkspaceRow>;
      select?: Record<string, boolean>;
    }) => {
      if (store.uniqueViolationOnNextWrite) {
        store.uniqueViolationOnNextWrite = false;
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        });
      }
      const row = store.workspaces.find((w) => w.id === where.id)!;
      Object.assign(row, data);
      return pick(row, select);
    },
    count: async ({ where }: { where: Where }) =>
      store.workspaces.filter((w) => matches(w, where)).length,
    delete: async ({ where }: { where: { id: string } }) => {
      store.workspaces = store.workspaces.filter((w) => w.id !== where.id);
      store.deleted.push(`workspace.delete:${where.id}`);
      return {};
    },
  };
  const apiKey = {
    findFirst: async ({
      where,
    }: {
      where: { userId?: string; workspaceId?: string };
    }) =>
      store.apiKeys.find(
        (k) =>
          (!where.userId || k.userId === where.userId) &&
          (!where.workspaceId || k.workspaceId === where.workspaceId),
      ) ?? null,
    findMany: async ({ where }: { where: { workspaceId: string } }) =>
      store.apiKeys.filter((k) => k.workspaceId === where.workspaceId),
    create: async ({ data }: { data: (typeof store.apiKeys)[number] }) => {
      store.apiKeys.push(data);
      return data;
    },
    deleteMany: async ({ where }: { where: { workspaceId: string } }) => {
      store.apiKeys = store.apiKeys.filter(
        (k) => k.workspaceId !== where.workspaceId,
      );
      store.deleted.push("apiKey.deleteMany");
      return {};
    },
  };
  const swept = (name: string) => ({
    deleteMany: async () => {
      store.deleted.push(`${name}.deleteMany`);
      return {};
    },
  });
  const models = {
    workspace,
    apiKey,
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    requestLog: swept("requestLog"),
    skill: swept("skill"),
    agent: swept("agent"),
    appConnection: swept("appConnection"),
    secret: swept("secret"),
    appConfig: swept("appConfig"),
    vaultConnection: swept("vaultConnection"),
    onboardingSurvey: swept("onboardingSurvey"),
    auditLog: swept("auditLog"),
  };
  return {
    Prisma: {},
    db: {
      ...models,
      $transaction: async (fn: (tx: typeof models) => Promise<unknown>) =>
        fn(models),
    },
  };
});

vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForKeys: (keys: string[]) => {
    store.flushed.push(...keys);
  },
}));

vi.mock("../../services/channels/agent-channel-service", () => ({
  teardownWorkspacePresences: async () => {},
}));

vi.mock("../../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return { logger };
});

import {
  createOrgWorkspace,
  createWorkspace,
  deleteOrgWorkspace,
  deleteWorkspace,
  getWorkspaceById,
  listOrgWorkspacesForUser,
  updateOrgWorkspace,
} from "./workspace-service";

const ORG = "org-1";

beforeEach(() => {
  store.workspaces = [
    {
      id: "ws-a",
      name: "Alpha",
      slug: "alpha",
      organizationId: ORG,
      createdByUserId: "owner",
      createdAt: new Date("2026-01-01"),
    },
    {
      id: "ws-b",
      name: "Beta",
      slug: "beta",
      organizationId: ORG,
      createdByUserId: "other",
      createdAt: new Date("2026-01-02"),
    },
    {
      id: "ws-x",
      name: "Foreign",
      slug: "foreign",
      organizationId: "org-2",
      createdByUserId: "x",
      createdAt: new Date("2026-01-03"),
    },
  ];
  store.bindings = [{ workspaceId: "ws-a", userId: "bound" }];
  store.apiKeys = [{ key: "oc_a", userId: "owner", workspaceId: "ws-a" }];
  store.deleted = [];
  store.flushed = [];
  store.uniqueViolationOnNextWrite = false;
});

describe("createWorkspace (web action)", () => {
  it("seeds the creator's API key and owner binding with the row", async () => {
    const created = await createWorkspace(
      "u1",
      "u1@example.com",
      " Team A ",
      ORG,
    );
    expect(created.name).toBe("Team A");
    expect(created.slug).toMatch(/^team-a-[0-9a-z]{6}$/);
    const row = store.workspaces.find((w) => w.id === created.id)!;
    expect(row.accessBindings).toEqual({
      create: { userId: "u1", role: "owner" },
    });
    expect(store.apiKeys.some((k) => k.workspaceId === created.id)).toBe(true);
  });

  it.each([
    ["", "At least 2"],
    ["a", "At least 2"],
    ["x".repeat(51), "At most 50"],
    ["***", "letter or number"],
  ])("rejects %p", async (name, fragment) => {
    await expect(
      createWorkspace("u1", "u1@example.com", name, ORG),
    ).rejects.toThrow(fragment);
  });
});

describe("the /v1/workspaces reads", () => {
  it("admins see every workspace in the org; members see their bindings", async () => {
    const forAdmin = await listOrgWorkspacesForUser("admin", ORG, "admin");
    expect(forAdmin.map((w) => w.id)).toEqual(["ws-a", "ws-b"]);
    expect(forAdmin[0]).toEqual({
      id: "ws-a",
      name: "Alpha",
      slug: "alpha",
      createdAt: new Date("2026-01-01"),
    });
    const forMember = await listOrgWorkspacesForUser("bound", ORG, "member");
    expect(forMember.map((w) => w.id)).toEqual(["ws-a"]);
    await expect(
      listOrgWorkspacesForUser("plain", ORG, "member"),
    ).resolves.toEqual([]);
  });

  it("the org fence: an owner of org-1 never sees org-2's workspace, whatever role is passed", async () => {
    await expect(
      listOrgWorkspacesForUser("owner", ORG, "owner"),
    ).resolves.not.toContainEqual(expect.objectContaining({ id: "ws-x" }));
    await expect(
      getWorkspaceById("owner", ORG, "ws-x", "owner"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
    await expect(
      updateOrgWorkspace(ORG, "ws-x", { name: "Taken" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteOrgWorkspace(ORG, "ws-x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("getWorkspaceById 404s an unseen workspace — never a 403, never a leak", async () => {
    await expect(
      getWorkspaceById("bound", ORG, "ws-a", "member"),
    ).resolves.toMatchObject({
      id: "ws-a",
    });
    for (const [userId, role, target] of [
      ["bound", "member", "ws-b"],
      ["admin", "admin", "ws-x"],
      ["admin", "admin", "ws-missing"],
    ] as const) {
      await expect(
        getWorkspaceById(userId, ORG, target, role),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Workspace not found",
      });
    }
  });
});

describe("createOrgWorkspace (POST /workspaces)", () => {
  it("creates with the owner binding and returns the creator's raw key", async () => {
    const created = await createOrgWorkspace(ORG, "owner", {
      name: "Probe One",
    });
    expect(created).toMatchObject({ name: "Probe One", slug: "probe-one" });
    expect(created.apiKey).toMatch(/^oc_/);
    const row = store.workspaces.find((w) => w.id === created.id)!;
    expect(row.accessBindings).toEqual({
      create: { userId: "owner", role: "owner" },
    });
  });

  it("409s a slug already taken in the org", async () => {
    await expect(
      createOrgWorkspace(ORG, "owner", { name: "Alpha" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: 'A workspace with slug "alpha" already exists',
    });
  });

  it("a concurrent same-slug writer that wins the race is still a 409, never a 500", async () => {
    // The pre-check passes (no such slug yet); the write itself then hits
    // the unique constraint because someone else created it in between.
    store.uniqueViolationOnNextWrite = true;
    await expect(
      createOrgWorkspace(ORG, "owner", { name: "Raced" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: 'A workspace with slug "raced" already exists',
    });
    // Any other write failure propagates untouched.
    store.uniqueViolationOnNextWrite = false;
  });
});

describe("updateOrgWorkspace", () => {
  it("renames and re-derives the slug", async () => {
    await expect(
      updateOrgWorkspace(ORG, "ws-b", { name: "Beta Two" }),
    ).resolves.toMatchObject({
      id: "ws-b",
      name: "Beta Two",
      slug: "beta-two",
    });
  });

  it("a rename that loses the slug race is a 409 too", async () => {
    store.uniqueViolationOnNextWrite = true;
    await expect(
      updateOrgWorkspace(ORG, "ws-b", { name: "Raced" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("409s when the new slug collides with a sibling, 404s outside the org", async () => {
    await expect(
      updateOrgWorkspace(ORG, "ws-b", { name: "Alpha" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      updateOrgWorkspace(ORG, "ws-x", { name: "Nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deleteOrgWorkspace / deleteWorkspace", () => {
  it("404s outside the org and refuses the org's only workspace", async () => {
    await expect(deleteOrgWorkspace(ORG, "ws-x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    store.workspaces = store.workspaces.filter((w) => w.id !== "ws-b");
    await expect(deleteOrgWorkspace(ORG, "ws-a")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot delete the only workspace in the organization",
    });
    expect(store.deleted).toEqual([]);
  });

  it("captures the keys, cascades children before the row, then flushes exactly those keys", async () => {
    await deleteWorkspace("ws-a");
    expect(store.workspaces.map((w) => w.id)).toEqual(["ws-b", "ws-x"]);
    expect(store.flushed).toEqual(["oc_a"]);
    expect(store.deleted.at(-1)).toBe("workspace.delete:ws-a");
    expect(store.deleted.indexOf("agent.deleteMany")).toBeLessThan(
      store.deleted.indexOf("workspace.delete:ws-a"),
    );
    expect(store.deleted.indexOf("apiKey.deleteMany")).toBeLessThan(
      store.deleted.indexOf("workspace.delete:ws-a"),
    );
  });
});
