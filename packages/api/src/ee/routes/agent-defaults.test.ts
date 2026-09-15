import { beforeEach, describe, expect, it, vi } from "vitest";

// The agent-defaults routes' HTTP contract: auth, the requireWorkspaceManagement
// gate, param/body validation, status codes, and the service-call wiring —
// mirrors routes/grants.ts's shape one level up (workspace scope instead of
// agent scope). The service's own laws (pool fencing, tool-id validation,
// upsert semantics) live in agent-default-connections-service.test.ts.

const ORG_KEY = "oc_org_test-key";
const WORKSPACE = "ws-1";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  listWorkspaceAgentDefaults: vi.fn(),
  setWorkspaceAgentDefault: vi.fn(),
  removeWorkspaceAgentDefault: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findFirst: async () => null,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
        status: "active",
      }),
    },
    workspace: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === WORKSPACE
          ? { id: WORKSPACE, organizationId: "org-1" }
          : null,
      // requireWorkspaceManagement's own pre-check (WP-A's fix round): reads
      // the workspace's real org and 404s on a mismatch with the caller's
      // CURRENT org context, before any manage/access predicate runs.
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === WORKSPACE
          ? { id: WORKSPACE, organizationId: "org-1" }
          : null,
    },
    workspaceAccess: { findFirst: async () => null },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/agent-default-connections-service", () => ({
  listWorkspaceAgentDefaults: services.listWorkspaceAgentDefaults,
  setWorkspaceAgentDefault: services.setWorkspaceAgentDefault,
  removeWorkspaceAgentDefault: services.removeWorkspaceAgentDefault,
}));

vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCacheForOrg: () => {},
  invalidateGatewayCache: () => {},
}));

const { createApiApp } = await import("../../app");

const app = createApiApp({ getSession: async () => null });

const AUTH = { authorization: `Bearer ${ORG_KEY}` };
const SCOPE = { workspaceId: WORKSPACE, organizationId: "org-1" };
const TEMPLATE = [
  {
    connectionId: "c1",
    provider: "github",
    label: "GitHub",
    scope: "workspace" as const,
    access: "full" as const,
    allow: [],
    ask: [],
    resources: null,
  },
];

const path = (suffix = "") =>
  `/v1/workspaces/${WORKSPACE}/agent-defaults${suffix}`;

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  services.listWorkspaceAgentDefaults.mockResolvedValue(TEMPLATE);
  services.setWorkspaceAgentDefault.mockResolvedValue(undefined);
  services.removeWorkspaceAgentDefault.mockResolvedValue(undefined);
});

describe("agent-defaults routes", () => {
  it("requires auth", async () => {
    const res = await app.request(path());
    expect(res.status).toBe(401);
  });

  it("404s an unseen workspace", async () => {
    const res = await app.request(
      `/v1/workspaces/ws-nonexistent/agent-defaults`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(services.listWorkspaceAgentDefaults).not.toHaveBeenCalled();
  });

  it("GET returns the workspace's template", async () => {
    const res = await app.request(path(), { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TEMPLATE);
    expect(services.listWorkspaceAgentDefaults).toHaveBeenCalledWith(SCOPE);
  });

  it("PUT rejects a malformed body with 422 and the standard error shape", async () => {
    const res = await app.request(path("/connections/c1"), {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ access: "custom", allow: [], ask: [] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("detach instead");
    expect(services.setWorkspaceAgentDefault).not.toHaveBeenCalled();
  });

  it("PUT sets the default and returns the refreshed template", async () => {
    const res = await app.request(path("/connections/c1"), {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ access: "full" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TEMPLATE);
    expect(services.setWorkspaceAgentDefault).toHaveBeenCalledWith(
      SCOPE,
      "c1",
      { access: "full" },
      "user-1",
    );
    // Re-reads after the write so the response always reflects what was
    // actually persisted, not an echo of the request body.
    expect(services.listWorkspaceAgentDefaults).toHaveBeenCalledWith(SCOPE);
  });

  it("DELETE removes the default with 204", async () => {
    const res = await app.request(path("/connections/c1"), {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(services.removeWorkspaceAgentDefault).toHaveBeenCalledWith(
      SCOPE,
      "c1",
    );
  });
});
