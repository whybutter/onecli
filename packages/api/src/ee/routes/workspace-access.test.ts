import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-contract tests for `/v1/workspaces/:id/access` (api-ee-behaviour
// §2.2), exercising the real middleware chain — read auth +
// `requireWorkspaceManagement` in-handler — against a hand-rolled
// @onecli/db mock.

const ORG_KEY = "oc_org_test-key";
const WORKSPACE_KEY = "oc_ws_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

interface BindingRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  workspaces: [
    { id: "ws-1", organizationId: "org-1", createdByUserId: "admin-1" },
  ],
  bindings: [] as BindingRow[],
  orgMembers: [
    {
      organizationId: "org-1",
      userId: "admin-1",
      role: "owner",
      status: "active",
    },
    {
      organizationId: "org-1",
      userId: "member-1",
      role: "member",
      status: "active",
    },
  ],
  users: [] as { id: string; name: string | null; email: string }[],
  groups: [] as { id: string; organizationId: string; name: string }[],
  auditLogs: [] as {
    action: string;
    workspaceId?: string;
    metadata: unknown;
  }[],
  nextId: 1,
}));

vi.mock("@onecli/db", () => {
  const db = {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === ORG_KEY) {
          return {
            userId: "admin-1",
            organizationId: "org-1",
            scope: "organization",
          };
        }
        if (where.key === WORKSPACE_KEY) {
          return { userId: "member-1", workspaceId: "ws-1", kind: "user" };
        }
        return null;
      },
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        return (
          store.orgMembers.find(
            (m) => m.organizationId === organizationId && m.userId === userId,
          ) ?? null
        );
      },
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
    workspace: {
      findFirst: async ({
        where,
      }: {
        where: {
          id: string;
          organization: {
            members: { some: { userId: string; status: { not: string } } };
          };
        };
      }) => {
        const workspace = store.workspaces.find((w) => w.id === where.id);
        if (!workspace) return null;
        const probe = where.organization.members.some;
        const member = store.orgMembers.find(
          (m) =>
            m.organizationId === workspace.organizationId &&
            m.userId === probe.userId &&
            m.status !== probe.status.not,
        );
        return member ? { organizationId: workspace.organizationId } : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const workspace = store.workspaces.find((w) => w.id === where.id);
        // Serves both the auth middleware's `{id, organizationId}` read and
        // `getWorkspaceAccessBindings`'s `{createdByUserId}` read — the
        // double ignores `select` and returns every field either caller
        // might ask for.
        return workspace ? { ...workspace } : null;
      },
    },
    workspaceAccess: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; userId?: string; role?: string };
      }) => {
        const row = store.bindings.find(
          (b) =>
            b.workspaceId === where.workspaceId &&
            (where.userId === undefined || b.userId === where.userId) &&
            (where.role === undefined || b.role === where.role),
        );
        return row ? { id: row.id } : null;
      },
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
                  return g ? { name: g.name, _count: { members: 0 } } : null;
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
          if (where.userId && b.userId && where.userId.in.includes(b.userId))
            return false;
          if (
            where.groupId &&
            b.groupId &&
            where.groupId.in.includes(b.groupId)
          )
            return false;
          return true;
        });
        return { count: before - store.bindings.length };
      },
      update: async ({
        where,
        data,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
        data: { role: string };
      }) => {
        const row = store.bindings.find(
          (b) =>
            b.workspaceId === where.workspaceId_userId.workspaceId &&
            b.userId === where.workspaceId_userId.userId,
        );
        if (!row) throw new Error("not found");
        row.role = data.role;
        return row;
      },
      createMany: async ({
        data,
      }: {
        data: {
          workspaceId: string;
          userId?: string;
          groupId?: string;
          role?: string;
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
    group: {
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; id: { in: string[] } };
      }) =>
        store.groups.filter(
          (g) =>
            g.organizationId === where.organizationId &&
            where.id.in.includes(g.id),
        ),
    },
    auditLog: {
      create: async ({
        data,
      }: {
        data: { action: string; workspaceId?: string; metadata: unknown };
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
import { workspaceAccessRoutes } from "./workspace-access";

const nullSession = { getSession: async () => null };
const orgKeyHeaders = {
  authorization: `Bearer ${ORG_KEY}`,
  "content-type": "application/json",
};
const wsKeyHeaders = {
  authorization: `Bearer ${WORKSPACE_KEY}`,
  "content-type": "application/json",
};

let app: Hono<ApiEnv>;

beforeAll(() => {
  app = createApiApp(nullSession, {
    roleResolver: { getUserRole },
    eeRoutes: (a) => {
      a.route("/workspaces", workspaceAccessRoutes());
    },
  });
});

beforeEach(() => {
  store.bindings = [];
  store.users = [];
  store.groups = [];
  store.auditLogs = [];
  store.nextId = 1;
});

describe("GET /v1/workspaces/:id/access", () => {
  it("an org admin/manager sees the bindings", async () => {
    store.bindings = [
      {
        id: "b1",
        workspaceId: "ws-1",
        userId: "admin-1",
        groupId: null,
        role: "owner",
        createdAt: new Date("2026-01-01"),
      },
    ];
    store.users = [
      { id: "admin-1", name: "Admin", email: "admin@example.com" },
    ];
    const res = await app.request("/v1/workspaces/ws-1/access", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { userId: string }[] };
    expect(body.users.map((u) => u.userId)).toEqual(["admin-1"]);
  });

  it("403s a shared-in (use-only) member", async () => {
    store.bindings = [
      {
        id: "b1",
        workspaceId: "ws-1",
        userId: "member-1",
        groupId: null,
        role: "member",
        createdAt: new Date(),
      },
    ];
    const res = await app.request("/v1/workspaces/ws-1/access", {
      headers: wsKeyHeaders,
    });
    expect(res.status).toBe(403);
  });

  it("404s a cross-org workspace id", async () => {
    const res = await app.request("/v1/workspaces/ws-missing/access", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /v1/workspaces/:id/access", () => {
  it("replaces the full set and audits scoped by workspaceId", async () => {
    const res = await app.request("/v1/workspaces/ws-1/access", {
      method: "PUT",
      headers: orgKeyHeaders,
      body: JSON.stringify({
        users: [{ userId: "member-1", role: "member" }],
        groupIds: [],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, removed: 0, roleChanged: 0 });
    expect(store.auditLogs).toMatchObject([
      { action: "update", workspaceId: "ws-1" },
    ]);
  });

  it("400s a non-active-member addition", async () => {
    const res = await app.request("/v1/workspaces/ws-1/access", {
      method: "PUT",
      headers: orgKeyHeaders,
      body: JSON.stringify({
        users: [{ userId: "ghost", role: "member" }],
        groupIds: [],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s an invalid body", async () => {
    const res = await app.request("/v1/workspaces/ws-1/access", {
      method: "PUT",
      headers: orgKeyHeaders,
      body: JSON.stringify({ users: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("a workspace key confined to a sibling workspace 404s before any predicate runs", async () => {
    // member-1 needs a binding on ws-1 for the workspace key ITSELF to
    // authenticate; the confinement check then fires on the sibling id the
    // request actually names.
    store.bindings = [
      {
        id: "b1",
        workspaceId: "ws-1",
        userId: "member-1",
        groupId: null,
        role: "member",
        createdAt: new Date(),
      },
    ];
    const res = await app.request("/v1/workspaces/ws-sibling/access", {
      method: "PUT",
      headers: wsKeyHeaders,
      body: JSON.stringify({ users: [], groupIds: [] }),
    });
    expect(res.status).toBe(404);
  });
});
