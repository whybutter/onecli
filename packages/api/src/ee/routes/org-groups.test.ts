import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-contract tests for `/v1/org/groups` (api-ee-behaviour §4.2),
// exercising the real middleware chain against a hand-rolled @onecli/db
// mock, house style per `routes/workspaces.test.ts`.

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

interface GroupRow {
  id: string;
  organizationId: string;
  name: string;
  source: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const store = vi.hoisted(() => ({
  groups: [] as GroupRow[],
  groupMembers: [] as { groupId: string; userId: string; createdAt: Date }[],
  orgMembers: [] as { organizationId: string; userId: string }[],
  users: [] as { id: string; email: string; name: string | null }[],
  auditLogs: [] as { action: string; metadata: unknown }[],
  nextGroupId: 1,
}));

const memberCount = (groupId: string) =>
  store.groupMembers.filter((m) => m.groupId === groupId).length;

vi.mock("@onecli/db", () => {
  const db = {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? {
              userId: "admin-1",
              organizationId: "org-1",
              scope: "organization",
            }
          : null,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({ role: "owner", status: "active" }),
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; userId: { in: string[] } };
      }) =>
        store.orgMembers.filter(
          (m) =>
            m.organizationId === where.organizationId &&
            where.userId.in.includes(m.userId),
        ),
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string; userId: string };
      }) =>
        store.orgMembers.find(
          (m) =>
            m.organizationId === where.organizationId &&
            m.userId === where.userId,
        ) ?? null,
    },
    group: {
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; source?: string };
      }) =>
        store.groups
          .filter((g) => g.organizationId === where.organizationId)
          .filter((g) => !where.source || g.source === where.source)
          .sort(
            (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
          )
          .map((g) => ({ ...g, _count: { members: memberCount(g.id) } })),
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) => {
        const g = store.groups.find(
          (x) => x.id === where.id && x.organizationId === where.organizationId,
        );
        return g ? { ...g, _count: { members: memberCount(g.id) } } : null;
      },
      create: async ({
        data,
      }: {
        data: { organizationId: string; name: string; source: string };
      }) => {
        if (
          store.groups.some(
            (g) =>
              g.organizationId === data.organizationId && g.name === data.name,
          )
        ) {
          throw { code: "P2002" };
        }
        const row: GroupRow = {
          id: `grp-${store.nextGroupId++}`,
          externalId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.groups.push(row);
        return { ...row, _count: { members: 0 } };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; organizationId: string };
        data: { name: string };
      }) => {
        const row = store.groups.find(
          (g) => g.id === where.id && g.organizationId === where.organizationId,
        );
        if (!row) return { count: 0 };
        if (
          store.groups.some(
            (g) =>
              g.id !== row.id &&
              g.organizationId === row.organizationId &&
              g.name === data.name,
          )
        ) {
          throw { code: "P2002" };
        }
        row.name = data.name;
        return { count: 1 };
      },
      deleteMany: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) => {
        const before = store.groups.length;
        store.groups = store.groups.filter(
          (g) =>
            !(g.id === where.id && g.organizationId === where.organizationId),
        );
        return { count: before - store.groups.length };
      },
    },
    groupMember: {
      findMany: async ({ where }: { where: { groupId: string } }) =>
        store.groupMembers
          .filter((m) => m.groupId === where.groupId)
          .map((m) => ({
            userId: m.userId,
            createdAt: m.createdAt,
            user: store.users.find((u) => u.id === m.userId) ?? {
              email: "",
              name: null,
            },
          })),
      findUnique: async ({
        where,
      }: {
        where: { groupId_userId: { groupId: string; userId: string } };
      }) =>
        store.groupMembers.find(
          (m) =>
            m.groupId === where.groupId_userId.groupId &&
            m.userId === where.groupId_userId.userId,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: { groupId: string; userId: string };
      }) => {
        const row = { ...data, createdAt: new Date() };
        store.groupMembers.push(row);
        return row;
      },
      createMany: async ({
        data,
      }: {
        data: { groupId: string; userId: string }[];
      }) => {
        for (const d of data) {
          if (
            !store.groupMembers.some(
              (m) => m.groupId === d.groupId && m.userId === d.userId,
            )
          ) {
            store.groupMembers.push({ ...d, createdAt: new Date() });
          }
        }
        return { count: data.length };
      },
      deleteMany: async ({
        where,
      }: {
        where: { groupId: string; userId?: string | { in: string[] } };
      }) => {
        const before = store.groupMembers.length;
        store.groupMembers = store.groupMembers.filter((m) => {
          if (m.groupId !== where.groupId) return true;
          if (where.userId === undefined) return false;
          if (typeof where.userId === "string")
            return m.userId !== where.userId;
          return !where.userId.in.includes(m.userId);
        });
        return { count: before - store.groupMembers.length };
      },
    },
    auditLog: {
      create: async ({
        data,
      }: {
        data: { action: string; metadata: unknown };
      }) => {
        store.auditLogs.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { Prisma: {}, db };
});

vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForKeys: () => {},
  invalidateGatewayCacheForOrg: () => {},
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCache: () => {},
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgGroupRoutes } from "./org-groups";

const nullSession = { getSession: async () => null };
const orgKeyHeaders = {
  authorization: `Bearer ${ORG_KEY}`,
  "content-type": "application/json",
};

let app: Hono<ApiEnv>;

beforeAll(() => {
  app = createApiApp(nullSession, {
    roleResolver: { getUserRole },
    eeRoutes: (a) => {
      a.route("/org/groups", orgGroupRoutes());
    },
  });
});

beforeEach(() => {
  store.groups = [];
  store.groupMembers = [];
  store.orgMembers = [
    { organizationId: "org-1", userId: "u1" },
    { organizationId: "org-1", userId: "u2" },
  ];
  store.users = [];
  store.auditLogs = [];
  store.nextGroupId = 1;
});

describe("GET/POST /v1/org/groups", () => {
  it("creates then lists a group", async () => {
    const create = await app.request("/v1/org/groups", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Engineering" }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      id: string;
      name: string;
      source: string;
    };
    expect(created).toMatchObject({
      name: "Engineering",
      source: "manual",
      memberCount: 0,
    });

    const list = await app.request("/v1/org/groups", {
      headers: orgKeyHeaders,
    });
    const body = (await list.json()) as { data: { id: string }[] };
    expect(body.data.map((g) => g.id)).toEqual([created.id]);
  });

  it("409s a duplicate name", async () => {
    await app.request("/v1/org/groups", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Engineering" }),
    });
    const res = await app.request("/v1/org/groups", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Engineering" }),
    });
    expect(res.status).toBe(409);
  });

  it("401s with no credentials", async () => {
    const res = await app.request("/v1/org/groups");
    expect(res.status).toBe(401);
  });
});

describe("GET/PATCH/DELETE /v1/org/groups/:groupId", () => {
  const seedGroup = async () => {
    const res = await app.request("/v1/org/groups", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Engineering" }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  it("404s an unknown group id", async () => {
    const res = await app.request("/v1/org/groups/nope", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("renames a group", async () => {
    const id = await seedGroup();
    const res = await app.request(`/v1/org/groups/${id}`, {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Platform" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Platform" });
  });

  it("deletes a group — 204", async () => {
    const id = await seedGroup();
    const res = await app.request(`/v1/org/groups/${id}`, {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(204);
    const list = await app.request("/v1/org/groups", {
      headers: orgKeyHeaders,
    });
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it("409s every manual mutation on a scim-sourced group", async () => {
    store.groups = [
      {
        id: "grp-scim",
        organizationId: "org-1",
        name: "Directory Group",
        source: "scim",
        externalId: "ext-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const rename = await app.request("/v1/org/groups/grp-scim", {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "New" }),
    });
    expect(rename.status).toBe(409);

    const del = await app.request("/v1/org/groups/grp-scim", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(del.status).toBe(409);

    const setMembers = await app.request("/v1/org/groups/grp-scim/members", {
      method: "PUT",
      headers: orgKeyHeaders,
      body: JSON.stringify({ userIds: ["u1"] }),
    });
    expect(setMembers.status).toBe(409);

    const addMember = await app.request("/v1/org/groups/grp-scim/members/u1", {
      method: "PUT",
      headers: orgKeyHeaders,
    });
    expect(addMember.status).toBe(409);

    const removeMember = await app.request(
      "/v1/org/groups/grp-scim/members/u1",
      {
        method: "DELETE",
        headers: orgKeyHeaders,
      },
    );
    expect(removeMember.status).toBe(409);
  });
});

describe("group membership routes", () => {
  const seedGroup = async () => {
    const res = await app.request("/v1/org/groups", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Engineering" }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  it("PUT /members full-replaces and returns the diff", async () => {
    const id = await seedGroup();
    const res = await app.request(`/v1/org/groups/${id}/members`, {
      method: "PUT",
      headers: orgKeyHeaders,
      body: JSON.stringify({ userIds: ["u1", "u2"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 2, removed: 0 });
  });

  it("PUT /members rejects a non-member id", async () => {
    const id = await seedGroup();
    const res = await app.request(`/v1/org/groups/${id}/members`, {
      method: "PUT",
      headers: orgKeyHeaders,
      body: JSON.stringify({ userIds: ["ghost"] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT/DELETE one member is idempotent and returns 204", async () => {
    const id = await seedGroup();
    const add1 = await app.request(`/v1/org/groups/${id}/members/u1`, {
      method: "PUT",
      headers: orgKeyHeaders,
    });
    expect(add1.status).toBe(204);
    const add2 = await app.request(`/v1/org/groups/${id}/members/u1`, {
      method: "PUT",
      headers: orgKeyHeaders,
    });
    expect(add2.status).toBe(204);

    const remove1 = await app.request(`/v1/org/groups/${id}/members/u1`, {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(remove1.status).toBe(204);
  });

  it("GET /members answers the directory envelope", async () => {
    const id = await seedGroup();
    const res = await app.request(`/v1/org/groups/${id}/members`, {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], nextCursor: null });
  });
});
