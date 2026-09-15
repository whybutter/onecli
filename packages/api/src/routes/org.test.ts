import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * GET /v1/org — the current-org read the create door rides.
 *
 * Three properties: the response carries exactly the org object plus the
 * creation-world column (`byoLegacy`, §3.10 re-decided 2026-08-23) and nothing
 * else; the org is resolved from the membership-fenced auth context, never
 * from input; and the `role: "member"` fence re-checks an API key's user
 * still holds an ACTIVE membership — a departed member's key reads nothing.
 *
 * PATCH /v1/org — rename (name only; `slug` is immutable). Owner-only: an
 * admin or plain member 403s before the service ever runs, audited
 * UPDATE/ORGANIZATION on success.
 */

const ORG = "org-1";
const ORG_KEY = "oc_org_test-key";

// Pinned onprem. RBAC is on in every edition of this build, so the org-key
// auth re-checks the holder's role through the membership row and a departed
// holder fails at key authentication itself (strict `oc_` bearer → 401).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const state = vi.hoisted(() => ({
  membershipActive: true,
  role: "owner" as string,
  orgQueries: [] as { id?: string }[],
  orgName: "Acme",
  auditEvents: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: ORG, scope: "organization" }
          : null,
    },
    user: {
      findUnique: async () => ({ id: "user-1", email: "admin@example.com" }),
    },
    organizationMember: {
      findFirst: async () =>
        state.membershipActive ? { userId: "user-1" } : null,
      // The role resolver's read (and renameOrganization's own re-check):
      // active at `state.role`, or no row once departed.
      findUnique: async () =>
        state.membershipActive
          ? { role: state.role, status: "active" }
          : null,
    },
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        state.orgQueries.push(where);
        return where.id === ORG
          ? {
              id: ORG,
              name: state.orgName,
              slug: "acme",
              byoLegacy: true,
              byoEnabled: false,
            }
          : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { name: string };
      }) => {
        if (where.id !== ORG) throw new Error("not found");
        state.orgName = data.name;
        return {
          id: ORG,
          name: state.orgName,
          slug: "acme",
          byoLegacy: true,
          byoEnabled: false,
        };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.auditEvents.push(data);
        return data;
      },
    },
  },
}));

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCacheForOrg: () => {},
  invalidateGatewayCache: () => {},
}));

let app: Hono<ApiEnv>;

beforeAll(async () => {
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => null });
});

beforeEach(() => {
  state.membershipActive = true;
  state.role = "owner";
  state.orgQueries = [];
  state.orgName = "Acme";
  state.auditEvents = [];
});

const authed = { headers: { Authorization: `Bearer ${ORG_KEY}` } };

describe("GET /v1/org", () => {
  it("returns the org with EXACTLY the org object + the creation world", async () => {
    const res = await app.request("/v1/org", authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The exact-key pin (the instance.test.ts convention): a new field must
    // be added here deliberately, and a leaked column fails loudly.
    expect(Object.keys(body).sort()).toEqual([
      "byoEnabled",
      "byoLegacy",
      "id",
      "name",
      "slug",
    ]);
    expect(body).toEqual({
      id: ORG,
      name: "Acme",
      slug: "acme",
      byoLegacy: true,
      byoEnabled: false,
    });
  });

  it("resolves the org from the KEY's auth context, never from input", async () => {
    // A crafted header must not steer the read — the query's id is the key
    // row's org, by construction.
    await app.request("/v1/org", {
      headers: { ...authed.headers, "x-organization-id": "org-evil" },
    });
    expect(state.orgQueries).toEqual([{ id: ORG }]);
  });

  it("401s an anonymous caller", async () => {
    const res = await app.request("/v1/org");
    expect(res.status).toBe(401);
  });

  it("401s a departed member's still-live API key (the member fence)", async () => {
    // An org key is an admin capability: once its holder is no longer an
    // active admin/owner the key stops authenticating at all — the demotion
    // re-check in the api-key resolver, ahead of the route's role option.
    state.membershipActive = false;
    const res = await app.request("/v1/org", authed);
    expect(res.status).toBe(401);
    // And the org row was never read.
    expect(state.orgQueries).toEqual([]);
  });
});

describe("PATCH /v1/org", () => {
  const rename = (name: string) =>
    app.request("/v1/org", {
      method: "PATCH",
      headers: { ...authed.headers, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });

  it("renames as the owner and returns the updated org", async () => {
    const res = await rename("New Name");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ORG,
      name: "New Name",
      slug: "acme",
      byoLegacy: true,
      byoEnabled: false,
    });
    expect(state.orgName).toBe("New Name");
  });

  it("audits the rename as UPDATE/ORGANIZATION", async () => {
    await rename("Audited Co");

    expect(state.auditEvents).toHaveLength(1);
    expect(state.auditEvents[0]).toMatchObject({
      organizationId: ORG,
      userId: "user-1",
      action: "update",
      service: "organization",
      source: "api",
      metadata: { organizationId: ORG, change: "name", name: "Audited Co" },
    });
  });

  it("403s an admin — rename is owner-only", async () => {
    state.role = "admin";

    const res = await rename("Nope");

    expect(res.status).toBe(403);
    expect(state.orgName).toBe("Acme");
    expect(state.auditEvents).toHaveLength(0);
  });

  it("401s an anonymous caller", async () => {
    const res = await app.request("/v1/org", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s an empty name without touching the service", async () => {
    const res = await rename("");

    expect(res.status).toBe(400);
    expect(state.orgName).toBe("Acme");
  });

  it("400s a name over 255 characters", async () => {
    const res = await rename("x".repeat(256));

    expect(res.status).toBe(400);
    expect(state.orgName).toBe("Acme");
  });
});
