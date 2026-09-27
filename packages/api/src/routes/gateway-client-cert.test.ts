import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests for `POST /gateway/client-cert` (mounted at
 * `/v1/gateway/client-cert` in the full app). Focus: the auth boundary (no
 * session/API key -> 401, before any minting work happens), and that
 * `withAudit` is called with the right action/service and metadata that
 * never carries cert/key material — the property CLAUDE.md's audit-logging
 * section requires ("Never include sensitive values").
 *
 * `../lib/gateway-client-cert` is mocked so this never makes a real network
 * call to a gateway; `../middleware/auth` is replaced with a minimal stub
 * gated on a test-only header, so the 401 case exercises a REAL "no auth
 * context reaches the handler" path rather than assuming the real
 * session/API-key resolution would 401 (that's `middleware/auth.test.ts`'s
 * job). One test (the "org key + X-Workspace-Id" smoke test) flips
 * `authState.useReal` to route through the REAL `auth()` middleware instead
 * of the stub — proving `auth({ requireWorkspace: true })`'s existing
 * org-key-with-header resolution (not new, §0.11 of the Phase 4 plan) also
 * works for this specific route, without re-testing the mechanism itself
 * (that's `middleware/auth.test.ts`'s job too).
 */

interface FakeClientHostRow {
  id: string;
  workspaceId: string;
  organizationId?: string;
  label?: string;
  spiffeUri: string;
  revokedAt?: Date | null;
}

const state = vi.hoisted(() => ({
  auditRows: [] as Record<string, unknown>[],
  mintCalls: [] as Record<string, unknown>[],
  clientHosts: [] as FakeClientHostRow[],
  clientHostUpdates: [] as Record<string, unknown>[],
}));

// Toggled by the org-key smoke test only; every other test leaves this
// false and gets the simple test-header-gated stub below.
const authState = vi.hoisted(() => ({ useReal: false }));

const ORG_KEY = "oc_org_test-key";
const ORG_KEY_USER_ID = "user-1";
const ORG_KEY_ORG_ID = "org-1";
const ORG_KEY_WORKSPACE_ID = "ws-1";

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: null },
  db: {
    clientHost: {
      create: async (args: { data: FakeClientHostRow }) => {
        state.clientHosts.push({ ...args.data });
        return { id: args.data.id, spiffeUri: args.data.spiffeUri };
      },
      // Tenant-scoped, non-revoked lookup — mirrors the real Prisma query
      // exactly (`where: { id, workspaceId, revokedAt: null }`): a row
      // belonging to a DIFFERENT workspaceId, or a revoked one, is
      // indistinguishable from "doesn't exist" here, same as in Postgres,
      // which is the property the IDOR/revocation guard depends on.
      findFirst: async (args: {
        where: { id: string; workspaceId: string; revokedAt: null };
        select?: unknown;
      }) => {
        const found = state.clientHosts.find(
          (h) =>
            h.id === args.where.id &&
            h.workspaceId === args.where.workspaceId &&
            (h.revokedAt ?? null) === null,
        );
        return found ? { id: found.id, spiffeUri: found.spiffeUri } : null;
      },
      update: async (args: Record<string, unknown>) => {
        state.clientHostUpdates.push(args);
        return {};
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.auditRows.push(args.data);
        return {};
      },
    },
    apiKey: {
      findFirst: async () => null,
      findMany: async () => [],
      // Backs the org-key smoke test's `authenticateApiKey` call. Every
      // other test authenticates through the stubbed `../middleware/auth`
      // below and never reaches this.
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? {
              id: "apikey-org-1",
              key: ORG_KEY,
              userId: ORG_KEY_USER_ID,
              organizationId: ORG_KEY_ORG_ID,
              scope: "organization",
              lastUsedAt: null,
            }
          : null,
      // `recordApiKeyUse`'s fire-and-forget lastUsedAt stamp.
      updateMany: async () => ({ count: 1 }),
    },
    // `getUserRole` (the org-key admin re-check) and `resolveUserEmail`'s
    // reads, for the same smoke test.
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) =>
        where.organizationId_userId.organizationId === ORG_KEY_ORG_ID &&
        where.organizationId_userId.userId === ORG_KEY_USER_ID
          ? { role: "admin", status: "active" }
          : null,
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === ORG_KEY_USER_ID ? { email: "guy@acme.com" } : null,
    },
    // The org-key branch's X-Workspace-Id validation (in-org check).
    workspace: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) =>
        where.id === ORG_KEY_WORKSPACE_ID &&
        where.organizationId === ORG_KEY_ORG_ID
          ? { id: ORG_KEY_WORKSPACE_ID }
          : null,
    },
  },
}));

vi.mock("../lib/gateway-client-cert", () => ({
  mintClientCert: async (params: Record<string, unknown>) => {
    state.mintCalls.push(params);
    return {
      certPem: "LEAF-AND-CA-PEM",
      caPem: "CA-ONLY-PEM",
      serial: "abc123serial",
      notAfter: 1893456000,
    };
  },
}));

vi.mock("../middleware/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/auth")>();
  return {
    ...actual,
    auth:
      (options?: Parameters<typeof actual.auth>[0]) =>
      async (
        c: Parameters<ReturnType<typeof actual.auth>>[0],
        next: () => Promise<void>,
      ) => {
        // The org-key smoke test flips this to exercise the REAL
        // session/API-key resolution end to end; every other test gets the
        // fast test-header-gated stub below.
        if (authState.useReal) {
          return actual.auth(options)(c, next);
        }
        if (c.req.header("x-test-authed") !== "yes") {
          return c.json(
            {
              error: {
                message: "Invalid API key or token.",
                type: "authentication_error",
              },
            },
            401,
          );
        }
        c.set("auth", {
          userId: "user-1",
          userEmail: "guy@acme.com",
          organizationId: "org-1",
          workspaceId: "ws-1",
        });
        return next();
      },
  };
});

import { errorHandler } from "../middleware/error-handler";
import { getUserRole } from "../ee/services/authorization-service";
import { initRoleResolver } from "../providers";
import { clientCertRoutes } from "./gateway";

// Wires the real org-key admin re-check (`authenticateApiKey`'s org-key
// branch calls `getRoleResolver()`) to the mocked `organizationMember` table
// above — needed only by the smoke test below, which is the sole test that
// flips `authState.useReal`. Cheap to do unconditionally at module load
// (no edition-default graph pulled in, unlike `ensureEditionDefaults()`).
initRoleResolver({ getUserRole });

const VALID_CSR =
  "-----BEGIN CERTIFICATE REQUEST-----\nMIIBazCB7QIBADAA\n-----END CERTIFICATE REQUEST-----\n";

// `clientCertRoutes()` on its own has no error boundary — that's registered
// once on the root app in `app.ts` (`app.onError(errorHandler)`). Attach the
// same handler here so a thrown `ServiceError` (e.g. a validation failure)
// maps to its real status code instead of Hono's generic 500.
const app = clientCertRoutes();
app.onError(errorHandler);

const post = (body: unknown, authed: boolean) =>
  app.request("/client-cert", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authed ? { "x-test-authed": "yes" } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.auditRows = [];
  state.mintCalls = [];
  state.clientHosts = [];
  state.clientHostUpdates = [];
});

describe("POST /gateway/client-cert", () => {
  it("401s without auth, before any minting work happens", async () => {
    const res = await post({ csrPem: VALID_CSR }, false);
    expect(res.status).toBe(401);
    expect(state.mintCalls).toHaveLength(0);
    expect(state.clientHosts).toHaveLength(0);
    expect(state.auditRows).toHaveLength(0);
  });

  it("400s on a body missing csrPem", async () => {
    const res = await post({ label: "no-csr" }, true);
    expect(res.status).toBe(400);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("400s on a body carrying a key field instead of/alongside a CSR", async () => {
    const res = await post(
      {
        csrPem: VALID_CSR,
        keyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      },
      true,
    );
    expect(res.status).toBe(400);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("mints, audits mint/client-host with no key material, and returns the expected shape", async () => {
    const res = await post({ csrPem: VALID_CSR, label: "ci-runner-1" }, true);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      identity: string;
      hostId: string;
      certPem: string;
      caPem: string;
      serial: string;
      notAfter: number;
    };
    expect(body.certPem).toBe("LEAF-AND-CA-PEM");
    expect(body.caPem).toBe("CA-ONLY-PEM");
    expect(body.serial).toBe("abc123serial");
    expect(body.notAfter).toBe(1893456000);
    expect(body.identity).toMatch(/^spiffe:\/\/onecli\/host\/.+/);
    expect(body.hostId).toBeTruthy();
    // No key field anywhere in the response.
    expect(Object.keys(body).sort()).toEqual(
      ["caPem", "certPem", "hostId", "identity", "notAfter", "serial"].sort(),
    );

    expect(state.mintCalls).toHaveLength(1);
    expect(state.mintCalls[0]).toMatchObject({
      hostId: body.hostId,
      spiffeUri: body.identity,
      // The schema trims csrPem — assert against the trimmed form.
      csrPem: VALID_CSR.trim(),
    });

    expect(state.auditRows).toHaveLength(1);
    const audit = state.auditRows[0] as {
      action: string;
      service: string;
      userId: string;
      userEmail: string;
      workspaceId: string;
      organizationId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("mint");
    expect(audit.service).toBe("client-host");
    expect(audit.userId).toBe("user-1");
    expect(audit.userEmail).toBe("guy@acme.com");
    expect(audit.workspaceId).toBe("ws-1");
    expect(audit.organizationId).toBe("org-1");

    // The metadata guideline from CLAUDE.md: resource identifiers only, never
    // cert/key material. Assert both the exact shape AND (belt-and-braces)
    // that no PEM-looking string ever made it into the metadata blob.
    expect(audit.metadata).toEqual({
      hostId: body.hostId,
      spiffeUri: body.identity,
      serial: "abc123serial",
      notAfter: 1893456000,
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("PEM");
    expect(JSON.stringify(audit.metadata)).not.toContain("PRIVATE KEY");

    // The ClientHost row was stamped with the mint's serial after issuance.
    expect(state.clientHostUpdates).toHaveLength(1);
  });

  // ── ClientHost is per-HOST, not per-enrollment call ────────────

  it("first enrollment (no hostId) creates a new host", async () => {
    const res = await post({ csrPem: VALID_CSR, label: "relay-1" }, true);
    expect(res.status).toBe(200);
    expect(state.clientHosts).toHaveLength(1);

    const body = (await res.json()) as { hostId: string; identity: string };
    expect(state.clientHosts[0]?.id).toBe(body.hostId);
    expect(state.clientHosts[0]?.spiffeUri).toBe(body.identity);
  });

  it("omitting hostId always creates a NEW host, even for the same caller", async () => {
    await post({ csrPem: VALID_CSR }, true);
    await post({ csrPem: VALID_CSR }, true);
    expect(state.clientHosts).toHaveLength(2);
    expect(state.clientHosts[0]?.id).not.toBe(state.clientHosts[1]?.id);
  });

  it("renewal with the caller's own hostId reuses the same identity (no new row)", async () => {
    const first = await post({ csrPem: VALID_CSR, label: "relay-1" }, true);
    const firstBody = (await first.json()) as {
      hostId: string;
      identity: string;
    };
    expect(state.clientHosts).toHaveLength(1);

    const renewed = await post(
      { csrPem: VALID_CSR, hostId: firstBody.hostId },
      true,
    );
    expect(renewed.status).toBe(200);
    const renewedBody = (await renewed.json()) as {
      hostId: string;
      identity: string;
    };

    expect(renewedBody.hostId).toBe(firstBody.hostId);
    expect(renewedBody.identity).toBe(firstBody.identity);
    // Still exactly one row — the renewal reused it, it didn't create a
    // second one.
    expect(state.clientHosts).toHaveLength(1);
    expect(state.mintCalls).toHaveLength(2);
    expect(state.clientHostUpdates).toHaveLength(2);
  });

  // IDOR guard: an authenticated caller in one workspace must not be able to
  // reuse (or even learn the existence of) a ClientHost row that belongs to
  // a DIFFERENT workspace by guessing/supplying its hostId.
  it("renewal with another tenant's hostId is rejected — never falls through to creating a new row", async () => {
    state.clientHosts.push({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "some-other-tenants-workspace",
      spiffeUri: "spiffe://onecli/host/11111111-1111-4111-8111-111111111111",
    });

    const res = await post(
      { csrPem: VALID_CSR, hostId: "11111111-1111-4111-8111-111111111111" },
      true,
    );

    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
    expect(state.auditRows).toHaveLength(0);
    // No fallback create happened — still just the one seeded (other
    // tenant's) row.
    expect(state.clientHosts).toHaveLength(1);
  });

  it("renewal with a hostId that doesn't exist at all is rejected the same way", async () => {
    const res = await post(
      { csrPem: VALID_CSR, hostId: "22222222-2222-4222-8222-222222222222" },
      true,
    );
    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
    expect(state.clientHosts).toHaveLength(0);
  });

  // A revoked host must not be able to renew by re-presenting its own
  // hostId — the same NOT_FOUND treatment as the IDOR/nonexistent cases
  // above, so a caller can't distinguish "revoked" from "not mine"/"doesn't
  // exist" either. (Real-Postgres proof of the same property, over the
  // actual `revokedAt: null` filter, lives in
  // `client-host-service.pg.test.ts`.)
  it("renewal with a revoked host's own hostId is rejected the same way", async () => {
    state.clientHosts.push({
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "ws-1",
      spiffeUri: "spiffe://onecli/host/33333333-3333-4333-8333-333333333333",
      revokedAt: new Date(),
    });

    const res = await post(
      { csrPem: VALID_CSR, hostId: "33333333-3333-4333-8333-333333333333" },
      true,
    );

    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
    expect(state.auditRows).toHaveLength(0);
    // No fallback create happened — still just the one seeded (revoked) row.
    expect(state.clientHosts).toHaveLength(1);
  });
});

// ── Auth mechanism smoke test (real auth(), not the stub) ──────────────────

describe("POST /gateway/client-cert — org key + X-Workspace-Id (real auth)", () => {
  beforeEach(() => {
    authState.useReal = true;
    state.auditRows = [];
    state.mintCalls = [];
    state.clientHosts = [];
    state.clientHostUpdates = [];
  });

  afterEach(() => {
    authState.useReal = false;
  });

  /**
   * `auth({ requireWorkspace: true })` — this route's actual auth option —
   * already resolves an org-scoped `oc_org_` key's target workspace from an
   * explicit `X-Workspace-Id` header (validating org membership first, see
   * `middleware/auth/api-key.ts`). That mechanism is NOT new (§0.11 of the
   * Phase 4 plan) and has its own dedicated coverage in
   * `middleware/auth.test.ts`; this is a smoke test proving THIS route
   * enrolls successfully through it end to end — real `auth()` middleware,
   * mocked DB underneath.
   */
  it("enrolls successfully via an org key with X-Workspace-Id", async () => {
    const res = await app.request("/client-cert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ORG_KEY}`,
        "x-workspace-id": ORG_KEY_WORKSPACE_ID,
      },
      body: JSON.stringify({ csrPem: VALID_CSR, label: "org-key-relay" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hostId: string; identity: string };
    expect(body.identity).toMatch(/^spiffe:\/\/onecli\/host\/.+/);

    expect(state.mintCalls).toHaveLength(1);
    expect(state.auditRows).toHaveLength(1);
    const audit = state.auditRows[0] as {
      workspaceId: string;
      organizationId: string;
      userId: string;
    };
    expect(audit.workspaceId).toBe(ORG_KEY_WORKSPACE_ID);
    expect(audit.organizationId).toBe(ORG_KEY_ORG_ID);
    expect(audit.userId).toBe(ORG_KEY_USER_ID);
  });

  it("401s an org key with no X-Workspace-Id header (real auth's own rule)", async () => {
    const res = await app.request("/client-cert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ORG_KEY}`,
      },
      body: JSON.stringify({ csrPem: VALID_CSR }),
    });

    expect(res.status).toBe(401);
    expect(state.mintCalls).toHaveLength(0);
  });
});
