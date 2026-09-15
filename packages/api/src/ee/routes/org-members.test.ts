import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-contract tests for `/v1/org/members` (api-ee-behaviour §1.2),
// exercising the real middleware chain (org API key → admin role gate →
// handler) against a hand-rolled @onecli/db mock, house style per
// `routes/workspaces.test.ts`.

const ORG_KEY = "oc_org_test-key";
const MEMBER_KEY = "oc_org_member-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

interface MemberRow {
  organizationId: string;
  userId: string;
  userEmail: string;
  role: string;
  status: string;
  ssoExempt: boolean;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as { id: string; email: string; name: string | null }[],
  auditLogs: [] as { action: string; service: string; metadata: unknown }[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === ORG_KEY) {
          return {
            userId: "admin-1",
            organizationId: "org-1",
            scope: "organization",
          };
        }
        if (where.key === MEMBER_KEY) {
          return {
            userId: "user-2",
            organizationId: "org-1",
            scope: "organization",
          };
        }
        return null;
      },
      findMany: async () => [],
    },
    user: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; email?: string };
      }) => {
        if (where.email) {
          return store.users.find((u) => u.email === where.email) ?? null;
        }
        return { email: "admin@example.com" };
      },
      create: async ({
        data,
      }: {
        data: { email: string; name: string | null };
      }) => {
        const row = { id: `new-${store.users.length + 1}`, ...data };
        store.users.push(row);
        return row;
      },
    },
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
          store.members.find(
            (m) => m.organizationId === organizationId && m.userId === userId,
          ) ?? null
        );
      },
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string; userEmail: string };
      }) =>
        store.members.find(
          (m) =>
            m.organizationId === where.organizationId &&
            m.userEmail === where.userEmail,
        ) ?? null,
      findMany: async ({
        where,
      }: {
        where: {
          organizationId: string;
          NOT?: { userEmail: { endsWith: string } };
        };
      }) =>
        store.members
          .filter((m) => m.organizationId === where.organizationId)
          .filter(
            (m) =>
              !where.NOT || !m.userEmail.endsWith(where.NOT.userEmail.endsWith),
          )
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.userId.localeCompare(b.userId),
          )
          .map((m) => ({
            userId: m.userId,
            userEmail: m.userEmail,
            role: m.role,
            status: m.status,
            ssoExempt: m.ssoExempt,
            createdAt: m.createdAt,
            user: store.users.find((u) => u.id === m.userId) ?? null,
          })),
      update: async ({
        where,
        data,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
        data: Partial<MemberRow>;
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        const row = store.members.find(
          (m) => m.organizationId === organizationId && m.userId === userId,
        );
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: MemberRow }) => {
        const row = { ...data, createdAt: new Date() };
        store.members.push(row);
        return row;
      },
      delete: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        store.members = store.members.filter(
          (m) => !(m.organizationId === organizationId && m.userId === userId),
        );
        return {};
      },
    },
    group: { findMany: async () => [] },
    groupMember: { deleteMany: async () => ({ count: 0 }) },
    workspaceAccess: { deleteMany: async () => ({ count: 0 }) },
    workspace: { findMany: async () => [] },
    auditLog: {
      create: async ({
        data,
      }: {
        data: { action: string; service: string; metadata: unknown };
      }) => {
        store.auditLogs.push(data);
        return data;
      },
    },
  },
}));

vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForKeys: () => {},
  invalidateGatewayCacheForOrg: () => {},
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCache: () => {},
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

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgMemberRoutes } from "./org-members";

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
      a.route("/org/members", orgMemberRoutes());
    },
  });
});

beforeEach(() => {
  store.members = [
    {
      organizationId: "org-1",
      userId: "admin-1",
      userEmail: "admin@example.com",
      role: "owner",
      status: "active",
      ssoExempt: false,
      createdAt: new Date("2026-01-01"),
    },
    {
      organizationId: "org-1",
      userId: "user-2",
      userEmail: "user-2@example.com",
      role: "member",
      status: "active",
      ssoExempt: false,
      createdAt: new Date("2026-01-02"),
    },
  ];
  store.users = [];
  store.auditLogs = [];
});

describe("GET /v1/org/members", () => {
  it("lists members ordered createdAt asc, placeholders excluded", async () => {
    store.members.push({
      organizationId: "org-1",
      userId: "ghost",
      userEmail: "ghost@onecli.internal",
      role: "member",
      status: "active",
      ssoExempt: false,
      createdAt: new Date("2026-01-03"),
    });
    const res = await app.request("/v1/org/members", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string }[] };
    expect(body.data.map((m) => m.userId)).toEqual(["admin-1", "user-2"]);
  });

  it("400s an out-of-range limit", async () => {
    const res = await app.request("/v1/org/members?limit=9999", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(400);
  });

  it("401s with no credentials", async () => {
    const res = await app.request("/v1/org/members");
    expect(res.status).toBe(401);
  });

  it("401s an org key whose holder is not admin (the demotion re-check, §0.3)", async () => {
    // user-2 is a plain member: the org-key admin re-check fails AT KEY
    // AUTHENTICATION itself in strict mode, before the route ever runs —
    // §0.3's "an org-scoped API key whose holder is no longer admin ...
    // answers 401", not a 403.
    const res = await app.request("/v1/org/members", {
      headers: { authorization: `Bearer ${MEMBER_KEY}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/org/members", () => {
  it("creates a member, minting a placeholder user when unknown", async () => {
    const res = await app.request("/v1/org/members", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ email: "New@Example.com", name: "New Person" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      email: string;
      role: string;
      status: string;
    };
    expect(body).toMatchObject({
      email: "new@example.com",
      role: "member",
      status: "active",
    });
    expect(store.auditLogs).toHaveLength(1);
    expect(store.auditLogs[0]).toMatchObject({
      action: "create",
      service: "member",
    });
  });

  it("409s an existing member, no audit row", async () => {
    const res = await app.request("/v1/org/members", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ email: "user-2@example.com" }),
    });
    expect(res.status).toBe(409);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("400s an invalid email", async () => {
    const res = await app.request("/v1/org/members", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/org/members/:userId", () => {
  it("removes a member — 204", async () => {
    const res = await app.request("/v1/org/members/user-2", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(204);
    expect(store.members.some((m) => m.userId === "user-2")).toBe(false);
  });

  it("404s an unknown/cross-org user, no audit row", async () => {
    const res = await app.request("/v1/org/members/ghost", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(404);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("400s removing the owner, before any destructive step", async () => {
    const res = await app.request("/v1/org/members/admin-1", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(400);
    expect(store.members.some((m) => m.userId === "admin-1")).toBe(true);
  });
});

describe("PATCH /v1/org/members/:userId", () => {
  it("suspends and reinstates via { status }", async () => {
    const suspend = await app.request("/v1/org/members/user-2", {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(suspend.status).toBe(200);
    expect(await suspend.json()).toMatchObject({
      userId: "user-2",
      status: "suspended",
      revocation: "skipped",
    });

    const reinstate = await app.request("/v1/org/members/user-2", {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ status: "active" }),
    });
    expect(reinstate.status).toBe(200);
    expect(await reinstate.json()).toMatchObject({ status: "active" });
  });

  it("sets ssoExempt via { ssoExempt }", async () => {
    const res = await app.request("/v1/org/members/user-2", {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ ssoExempt: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user-2",
      status: "active",
      ssoExempt: true,
    });
  });

  it("400s both-at-once, unknown keys, and an empty body", async () => {
    for (const body of [
      { status: "suspended", ssoExempt: true },
      { role: "admin" },
      {},
    ]) {
      const res = await app.request("/v1/org/members/user-2", {
        method: "PATCH",
        headers: orgKeyHeaders,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("400s suspending the owner (a service refusal, no audit)", async () => {
    const res = await app.request("/v1/org/members/admin-1", {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(res.status).toBe(400);
    expect(store.auditLogs).toHaveLength(0);
  });
});

describe("GET /v1/org/members/:userId/groups", () => {
  it("answers the shared directory envelope", async () => {
    const res = await app.request("/v1/org/members/user-2/groups", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], nextCursor: null });
  });
});
