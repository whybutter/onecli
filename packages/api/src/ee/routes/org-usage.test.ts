import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/usage` route contract: the guard stack, not the aggregate itself
// (that's `usage-service.test.ts`'s job — mocked here so this suite only
// witnesses wiring). The one property that matters at this layer: an
// org-scoped credential reaches the read, a workspace-scoped one (an agent's
// own key) never does — request_logs has no organization_id column, so a
// workspace-scoped key granted org breadth here could enumerate volume across
// workspaces it was never issued for.

const ORG = "org-1";
const WORKSPACE = "ws-1";
const ORG_KEY = "oc_org_test-key";
const WORKSPACE_KEY = "oc_workspace-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const usage = {
  periodStart: "2026-08-12T00:00:00.000Z",
  periodEnd: "2026-09-11T00:00:00.000Z",
  requests: 3,
  integrationCalls: 1,
  agents: [],
};

const getOrganizationUsage = vi.hoisted(() => vi.fn(async () => usage));

vi.mock("../services/usage-service", () => ({ getOrganizationUsage }));

vi.mock("@onecli/db", () => ({
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === ORG_KEY)
          return {
            userId: "user-1",
            organizationId: ORG,
            scope: "organization",
          };
        if (where.key === WORKSPACE_KEY)
          return { userId: "user-1", workspaceId: WORKSPACE, kind: "user" };
        return null;
      },
      findFirst: async () => null,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    user: {
      findUnique: async () => ({ id: "user-1", email: "user@example.com" }),
    },
    organizationMember: {
      // Org keys are an admin capability by construction — the api-key
      // resolver re-checks admin+ before an org key authenticates at all, so
      // this suite (which exercises the route's OWN guard, not membership
      // visibility — that's usage-service.test.ts's job) pins an admin
      // membership throughout. This role also satisfies the workspace-key
      // branch's `canAccessWorkspaceAsUser` check (org admin/owner reaches
      // every workspace), so the workspace-scoped key case below fails at
      // the ROUTE's scope guard, not earlier at key authentication.
      findUnique: async () => ({ role: "admin", status: "active" }),
      findFirst: async () => ({ organizationId: ORG }),
    },
    workspace: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id === WORKSPACE ? { id: WORKSPACE, organizationId: ORG } : null,
      findFirst: async () => ({ id: WORKSPACE, organizationId: ORG }),
    },
    workspaceAccess: { findFirst: async () => null },
  },
}));

let app: Hono<ApiEnv>;

beforeAll(async () => {
  const { createApiApp } = await import("../../app");
  app = createApiApp({ getSession: async () => null });
});

beforeEach(() => {
  getOrganizationUsage.mockClear();
});

describe("GET /v1/org/usage", () => {
  it("serves usage for an org-scoped credential (member-visible, no admin gate)", async () => {
    const res = await app.request("/v1/org/usage", {
      headers: { Authorization: `Bearer ${ORG_KEY}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(usage);
    expect(getOrganizationUsage).toHaveBeenCalledWith(ORG, "user-1");
  });

  it("403s a workspace-scoped credential — org breadth needs an org credential", async () => {
    const res = await app.request("/v1/org/usage", {
      headers: { Authorization: `Bearer ${WORKSPACE_KEY}` },
    });

    expect(res.status).toBe(403);
    expect(getOrganizationUsage).not.toHaveBeenCalled();
  });

  it("401s an anonymous caller", async () => {
    const res = await app.request("/v1/org/usage");

    expect(res.status).toBe(401);
    expect(getOrganizationUsage).not.toHaveBeenCalled();
  });
});
