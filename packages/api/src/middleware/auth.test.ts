import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../types";

// The auth middleware bridges scope carried in the query string
// (_token/_workspace/_org) into the request headers so browser navigations that
// can't set headers — the app-connect → GET /v1/apps/:provider/authorize
// redirect — still resolve the right workspace. The regression these guard: with
// local auth the session is ambient (no _token JWT), so before the fix the
// _workspace param was ignored and the authorize fell back to the user's default
// workspace. Pin to oss so header-less requests fall back to the default
// workspace (CAPS.tenancy is org-per-user).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const USER = "user-1";
const ORG = "org-1";
const TARGET_WORKSPACE = "proj-target";
const DEFAULT_WORKSPACE = "proj-default";

// Togglable membership: the role-gate tests plant a NON-member to prove the
// membership fence (org/workspace resolution), not the role comparison, is
// what keeps outsiders off before the role gate even runs.
const membership = vi.hoisted(() => ({ active: true }));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === "oc_org_k1"
          ? { userId: USER, organizationId: ORG, scope: "organization" }
          : null,
    },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? {
              organizationMemberships: membership.active
                ? [{ organizationId: ORG }]
                : [],
            }
          : { id: USER, email: "owner@example.test" },
    },
    organizationMember: {
      findFirst: async () =>
        membership.active ? { organizationId: ORG } : null,
    },
    workspace: {
      // Header path (resolveWorkspaceId) queries by id; the default-workspace
      // fallback (findUserDefaultWorkspace) queries by createdByUserId.
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where?.id
          ? { id: where.id, organizationId: ORG, createdByUserId: USER }
          : { id: DEFAULT_WORKSPACE, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
  },
}));

import { auth } from "./auth";
import { initSession } from "../providers/session";
import { initSessionEnforcer } from "../providers/session-enforcer";
import { initRoleResolver } from "../providers/role-resolver";
import { initWorkspaceAccessChecker } from "../providers/access-checker";

const makeApp = () => {
  const app = new Hono<ApiEnv>();
  app.get("/echo", auth({ requireWorkspace: false }), (c) =>
    c.json({ workspaceId: c.get("auth").workspaceId }),
  );
  return app;
};

// A header-named workspace (as opposed to the createdByUserId-fallback
// default) is access-checked (`canAccessWorkspaceAsUser`, RBAC is enforced in
// every edition of this build; see CLAUDE.md). This suite is about the
// query-param → header bridge, not access control, so it wires a permissive
// checker rather than modeling the real admin-or-binding resolution.
const ALLOW_ALL = {
  canAccessWorkspaceAsUser: async () => true,
  userIsOrgAdmin: async () => true,
};

describe("auth middleware — scope query-param bridge", () => {
  beforeEach(() => initWorkspaceAccessChecker(ALLOW_ALL));
  afterEach(() => initWorkspaceAccessChecker(null));

  describe("ambient session (OSS local auth, no _token)", () => {
    // Mirrors the local-auth session provider: authenticated regardless of the
    // request (it reads the ambient Next.js session, not the passed request).
    beforeEach(() =>
      initSession({
        getSession: async () => ({
          id: "session-sub-1",
          email: "owner@example.test",
        }),
      }),
    );

    it("bridges ?_workspace into the workspace scope", async () => {
      const res = await makeApp().request(
        `/echo?_workspace=${TARGET_WORKSPACE}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("falls back to the default workspace without ?_workspace", async () => {
      const res = await makeApp().request("/echo");
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });

    it("does not let ?_workspace override a real x-workspace-id header", async () => {
      const res = await makeApp().request("/echo?_workspace=proj-evil", {
        headers: { "x-workspace-id": TARGET_WORKSPACE },
      });
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("degrades a malformed scope param to the default (no 500)", async () => {
      // A non-Latin1 value (emoji, %F0%9F%98%80) makes Headers.set throw; the
      // bridge must swallow it and authenticate as if the param were absent,
      // not surface a 500.
      const res = await makeApp().request("/echo?_workspace=%F0%9F%98%80");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });
  });

  describe("query-token session (cloud browser navigation)", () => {
    // Mirrors a header-reading (JWT) provider: authenticated only when the
    // bridged Authorization is present — proving _token → Authorization works.
    beforeEach(() =>
      initSession({
        getSession: async (req) =>
          req.headers.get("authorization") === "Bearer jwt-123"
            ? { id: "cloud-user", email: "u@example.com" }
            : null,
      }),
    );

    it("bridges ?_token into Authorization and ?_workspace into the scope", async () => {
      const res = await makeApp().request(
        `/echo?_token=jwt-123&_workspace=${TARGET_WORKSPACE}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("rejects when no _token and no session", async () => {
      const res = await makeApp().request(
        `/echo?_workspace=${TARGET_WORKSPACE}`,
      );
      expect(res.status).toBe(401);
    });
  });
});

describe("auth middleware — session-enforcer denial", () => {
  beforeEach(() => {
    initSession({
      getSession: async () => ({
        id: "session-sub-1",
        email: "owner@example.test",
      }),
    });
  });

  afterEach(() => {
    initSessionEnforcer(null);
  });

  it("maps an enforcer denial to an explicit 401 with the reason + code", async () => {
    initSessionEnforcer(async () => ({
      error: "Your organization requires single sign-on.",
      code: "sso_required",
    }));

    const res = await makeApp().request("/echo");
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; type: string; code?: string };
    };
    expect(body.error.code).toBe("sso_required");
    expect(body.error.message).toContain("single sign-on");
    expect(body.error.type).toBe("authentication_error");
  });

  it("an allowing enforcer authenticates normally", async () => {
    initSessionEnforcer(async () => null);
    const res = await makeApp().request("/echo");
    expect(res.status).toBe(200);
  });
});

describe("auth middleware — role gate", () => {
  const makeAdminApp = () => {
    const app = new Hono<ApiEnv>();
    app.get("/admin", auth({ requireWorkspace: false, role: "admin" }), (c) =>
      c.json({ role: c.get("auth").role ?? null }),
    );
    return app;
  };

  beforeEach(() => {
    initSession({
      getSession: async () => ({
        id: "session-sub-1",
        email: "owner@example.test",
      }),
    });
  });

  afterEach(() => {
    initRoleResolver(null);
    membership.active = true;
  });

  it("a caller with NO active membership never reaches the role comparison", async () => {
    // Org resolution itself (the active-membership fences in resolve.ts)
    // refuses an outsider before the role gate ever runs a comparison — with
    // or without an explicit x-organization-id.
    membership.active = false;

    const headerless = await makeAdminApp().request("/admin");
    expect(headerless.status).toBe(401);

    const withHeader = await makeAdminApp().request("/admin", {
      headers: { "x-organization-id": ORG },
    });
    expect(withHeader.status).toBe(401);
  });

  it("an ORG KEY whose holder has no role fails at key authentication (the admin re-check)", async () => {
    // Org keys are an admin capability by construction: `authenticateApiKey`
    // re-checks the holder's role on every request (a demoted or departed
    // holder's key stops working immediately, never reaching this route's
    // OWN role gate at all). No resolver result reads the same as "departed".
    initRoleResolver({ getUserRole: async () => null });

    const res = await makeAdminApp().request("/admin", {
      headers: { authorization: "Bearer oc_org_k1" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        message: "Invalid API key or token.",
        type: "authentication_error",
      },
    });
  });

  it("fails closed with no resolver at all (host wiring bug)", async () => {
    const res = await makeAdminApp().request("/admin");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "Not a member of this organization",
        type: "authentication_error",
      },
    });
  });

  it("a member below the threshold is refused", async () => {
    initRoleResolver({ getUserRole: async () => "member" });
    const res = await makeAdminApp().request("/admin");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "Insufficient permissions",
        type: "authentication_error",
      },
    });
  });

  it("an admin passes and the role lands on the auth context", async () => {
    initRoleResolver({ getUserRole: async () => "admin" });
    const res = await makeAdminApp().request("/admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "admin" });
  });
});
