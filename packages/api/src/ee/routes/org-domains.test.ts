import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-contract tests for `/v1/org/domains` (api-ee-behaviour §8.1),
// exercising the real middleware chain against a hand-rolled @onecli/db
// mock, with `node:dns/promises` mocked for the verify route.

const ORG_KEY = "oc_org_test-key";
const WORKSPACE_KEY = "oc_ws_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

interface DomainRow {
  id: string;
  organizationId: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  domains: [] as DomainRow[],
  auditLogs: [] as { action: string; metadata: unknown }[],
  nextId: 1,
}));

const dns = vi.hoisted(() => ({
  resolveTxt: vi.fn<(domain: string) => Promise<string[][]>>(),
}));
vi.mock("node:dns/promises", () => ({ resolveTxt: dns.resolveTxt }));

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
        if (where.key === WORKSPACE_KEY) {
          return { userId: "admin-1", workspaceId: "ws-1", kind: "user" };
        }
        return null;
      },
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({ role: "owner", status: "active" }),
    },
    workspace: {
      findUnique: async () => ({ id: "ws-1", organizationId: "org-1" }),
    },
    workspaceAccess: { findFirst: async () => null },
    organizationDomain: {
      count: async ({ where }: { where: { organizationId: string } }) =>
        store.domains.filter((d) => d.organizationId === where.organizationId)
          .length,
      findMany: async ({ where }: { where: { organizationId: string } }) =>
        store.domains
          .filter((d) => d.organizationId === where.organizationId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) =>
        store.domains.find(
          (d) => d.id === where.id && d.organizationId === where.organizationId,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: Omit<DomainRow, "id" | "verifiedAt" | "createdAt">;
      }) => {
        if (store.domains.some((d) => d.domain === data.domain)) {
          throw { code: "P2002" };
        }
        const row: DomainRow = {
          id: `dom-${store.nextId++}`,
          verifiedAt: null,
          createdAt: new Date(),
          ...data,
        };
        store.domains.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; organizationId: string };
        data: Partial<DomainRow>;
      }) => {
        const row = store.domains.find(
          (d) => d.id === where.id && d.organizationId === where.organizationId,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) => {
        const before = store.domains.length;
        store.domains = store.domains.filter(
          (d) =>
            !(d.id === where.id && d.organizationId === where.organizationId),
        );
        return { count: before - store.domains.length };
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
  },
}));

vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForKeys: () => {},
  invalidateGatewayCacheForOrg: () => {},
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCache: () => {},
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgDomainRoutes } from "./org-domains";

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
      a.route("/org/domains", orgDomainRoutes());
    },
  });
});

beforeEach(() => {
  store.domains = [];
  store.auditLogs = [];
  store.nextId = 1;
  dns.resolveTxt.mockReset();
});

describe("GET/POST /v1/org/domains", () => {
  it("claims a domain, token included", async () => {
    const res = await app.request("/v1/org/domains", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ domain: "Example.COM" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      domain: string;
      verificationToken: string;
      verifiedAt: string | null;
    };
    expect(body.domain).toBe("example.com");
    expect(body.verificationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.verifiedAt).toBeNull();
    expect(store.auditLogs).toMatchObject([{ action: "create" }]);
  });

  it("400s an invalid domain", async () => {
    const res = await app.request("/v1/org/domains", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ domain: "http://example.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s a public mailbox provider", async () => {
    const res = await app.request("/v1/org/domains", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ domain: "gmail.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("lists the org's domains", async () => {
    await app.request("/v1/org/domains", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ domain: "example.com" }),
    });
    const res = await app.request("/v1/org/domains", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: string }[];
    expect(body.map((d) => d.domain)).toEqual(["example.com"]);
  });

  it("401s with no credentials", async () => {
    const res = await app.request("/v1/org/domains");
    expect(res.status).toBe(401);
  });

  it("403s a workspace-scoped credential", async () => {
    const res = await app.request("/v1/org/domains", {
      headers: { authorization: `Bearer ${WORKSPACE_KEY}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a 26th domain for the org", async () => {
    for (let i = 0; i < 25; i++) {
      await app.request("/v1/org/domains", {
        method: "POST",
        headers: orgKeyHeaders,
        body: JSON.stringify({ domain: `d${i}.example.com` }),
      });
    }
    const res = await app.request("/v1/org/domains", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ domain: "one-too-many.example.com" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/org/domains/:domainId/verify", () => {
  const claim = async () => {
    const res = await app.request("/v1/org/domains", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ domain: "example.com" }),
    });
    return (await res.json()) as { id: string; verificationToken: string };
  };

  it("verifies with a matching TXT record, audited", async () => {
    const claimed = await claim();
    dns.resolveTxt.mockResolvedValue([
      [`onecli-verification=${claimed.verificationToken}`],
    ]);
    const res = await app.request(`/v1/org/domains/${claimed.id}/verify`, {
      method: "POST",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verifiedAt: string | null };
    expect(body.verifiedAt).not.toBeNull();
    expect(store.auditLogs).toContainEqual(
      expect.objectContaining({ action: "verify" }),
    );
  });

  it("400s when the record is missing yet", async () => {
    const claimed = await claim();
    dns.resolveTxt.mockRejectedValue(
      Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
    );
    const res = await app.request(`/v1/org/domains/${claimed.id}/verify`, {
      method: "POST",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(400);
  });

  it("404s a cross-org domain id", async () => {
    const res = await app.request("/v1/org/domains/dom-999/verify", {
      method: "POST",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("does NOT audit the idempotent already-verified re-check — no DNS call, no fresh VERIFY event", async () => {
    const claimed = await claim();
    dns.resolveTxt.mockResolvedValue([
      [`onecli-verification=${claimed.verificationToken}`],
    ]);
    await app.request(`/v1/org/domains/${claimed.id}/verify`, {
      method: "POST",
      headers: orgKeyHeaders,
    });
    store.auditLogs = [];
    dns.resolveTxt.mockClear();
    const again = await app.request(`/v1/org/domains/${claimed.id}/verify`, {
      method: "POST",
      headers: orgKeyHeaders,
    });
    expect(again.status).toBe(200);
    expect(store.auditLogs).toEqual([]);
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });
});

describe("DELETE /v1/org/domains/:domainId", () => {
  it("deletes — 204", async () => {
    const create = await app.request("/v1/org/domains", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ domain: "example.com" }),
    });
    const { id } = (await create.json()) as { id: string };
    const res = await app.request(`/v1/org/domains/${id}`, {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(204);
  });

  it("404s when nothing matched", async () => {
    const res = await app.request("/v1/org/domains/nope", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(404);
  });
});
