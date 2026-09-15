import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-level contract tests for `/v1/org/budgets`: the admin gate, the
// workspace-scope-credential guard, zod body validation → 422, and the
// ServiceError → status mapping (404/400/409). The service layer is mocked.

const ORG_KEY = "oc_org_test-key";
const WORKSPACE_KEY = "oc_workspace_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
  throwOnCreate: null as null | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  throwOnUpdate: null as null | "NOT_FOUND",
  throwOnDelete: null as null | "NOT_FOUND",
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === ORG_KEY) {
          return {
            userId: "user-1",
            organizationId: "org-1",
            scope: "organization",
          };
        }
        if (where.key === WORKSPACE_KEY) {
          return {
            userId: "user-1",
            workspaceId: "ws-1",
            kind: "user",
          };
        }
        return null;
      },
      findMany: async () => [], // withAudit's gateway flush enumerates keys
    },
    workspace: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "ws-1" ? { id: "ws-1", organizationId: "org-1" } : null,
    },
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
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
    },
    auditLog: { create: async () => ({}) },
  },
}));

const calls = vi.hoisted(() => ({ create: 0, update: 0, del: 0 }));

vi.mock("../services/budget-service", async () => {
  const { ServiceError } = await import("../../services/errors");
  const row = {
    id: "budget-1",
    secretId: "sec-1",
    secretName: "Anthropic key",
    secretType: "anthropic",
    limitCents: 5000,
    period: "monthly",
    spentCents: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    listBudgets: async () => [row],
    createBudget: async () => {
      if (store.throwOnCreate) {
        throw new ServiceError(store.throwOnCreate, "rejected");
      }
      calls.create += 1;
      return row;
    },
    updateBudget: async () => {
      if (store.throwOnUpdate) {
        throw new ServiceError(store.throwOnUpdate, "not found");
      }
      calls.update += 1;
      return row;
    },
    deleteBudget: async () => {
      if (store.throwOnDelete) {
        throw new ServiceError(store.throwOnDelete, "not found");
      }
      calls.del += 1;
      return { id: "budget-1", secretId: "sec-1" };
    },
  };
});

// Canary import path check: also exercise the module for a workspace-access
// helper the workspace-key path needs (flat-team OSS is a no-op, but the
// import must resolve).
vi.mock("../../services/workspace-access-check", () => ({
  canAccessWorkspaceAsUser: async () => true,
  userIsOrgAdmin: async () => true,
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  app = createApiApp(nullSession, { roleResolver: { getUserRole } });
});

const orgAuthed = { headers: { Authorization: `Bearer ${ORG_KEY}` } };
const workspaceAuthed = {
  headers: { Authorization: `Bearer ${WORKSPACE_KEY}` },
};

const post = (body: unknown) => ({
  ...orgAuthed,
  method: "POST",
  body: JSON.stringify(body),
});

const patch = (body: unknown) => ({
  ...orgAuthed,
  method: "PATCH",
  body: JSON.stringify(body),
});

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "admin" },
  ];
  store.throwOnCreate = null;
  store.throwOnUpdate = null;
  store.throwOnDelete = null;
  calls.create = 0;
  calls.update = 0;
  calls.del = 0;
});

describe("authz", () => {
  it("lists budgets for an org-admin", async () => {
    const res = await app.request("/v1/org/budgets", orgAuthed);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/org/budgets");
    expect(res.status).toBe(401);
  });

  it("401s an org key whose user is below admin", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
    const res = await app.request("/v1/org/budgets", orgAuthed);
    expect(res.status).toBe(401);
  });

  it("403s a workspace-scoped credential (org budgets require an org-scoped credential)", async () => {
    const res = await app.request("/v1/org/budgets", workspaceAuthed);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "Organization budgets require an organization-scoped credential.",
    );
  });
});

describe("POST /", () => {
  const validBody = { secretId: "sec-1", limitCents: 5000, period: "monthly" };

  it("creates a budget (201)", async () => {
    const res = await app.request("/v1/org/budgets", post(validBody));
    expect(res.status).toBe(201);
    expect(calls.create).toBe(1);
  });

  it("422s a missing secretId", async () => {
    const res = await app.request(
      "/v1/org/budgets",
      post({ limitCents: 5000, period: "monthly" }),
    );
    expect(res.status).toBe(422);
    expect(calls.create).toBe(0);
  });

  it("422s a non-positive limitCents", async () => {
    const res = await app.request(
      "/v1/org/budgets",
      post({ ...validBody, limitCents: 0 }),
    );
    expect(res.status).toBe(422);
  });

  it("422s a non-integer limitCents", async () => {
    const res = await app.request(
      "/v1/org/budgets",
      post({ ...validBody, limitCents: 12.5 }),
    );
    expect(res.status).toBe(422);
  });

  it("defaults period to monthly when omitted", async () => {
    const res = await app.request(
      "/v1/org/budgets",
      post({ secretId: "sec-1", limitCents: 5000 }),
    );
    expect(res.status).toBe(201);
  });

  it("422s an invalid period", async () => {
    const res = await app.request(
      "/v1/org/budgets",
      post({ ...validBody, period: "weekly" }),
    );
    expect(res.status).toBe(422);
  });

  it("404s when the service reports the secret isn't the org's", async () => {
    store.throwOnCreate = "NOT_FOUND";
    const res = await app.request("/v1/org/budgets", post(validBody));
    expect(res.status).toBe(404);
  });

  it("400s a non-metered secret type", async () => {
    store.throwOnCreate = "BAD_REQUEST";
    const res = await app.request("/v1/org/budgets", post(validBody));
    expect(res.status).toBe(400);
  });

  it("409s a duplicate (secretId, org) budget", async () => {
    store.throwOnCreate = "CONFLICT";
    const res = await app.request("/v1/org/budgets", post(validBody));
    expect(res.status).toBe(409);
  });
});

describe("PATCH /:id", () => {
  it("updates a budget (200)", async () => {
    const res = await app.request(
      "/v1/org/budgets/budget-1",
      patch({ limitCents: 9000 }),
    );
    expect(res.status).toBe(200);
    expect(calls.update).toBe(1);
  });

  it("422s an empty patch body", async () => {
    const res = await app.request("/v1/org/budgets/budget-1", patch({}));
    expect(res.status).toBe(422);
    expect(calls.update).toBe(0);
  });

  it("404s an unknown budget id", async () => {
    store.throwOnUpdate = "NOT_FOUND";
    const res = await app.request(
      "/v1/org/budgets/nope",
      patch({ limitCents: 1 }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:id", () => {
  it("deletes a budget (204)", async () => {
    const res = await app.request("/v1/org/budgets/budget-1", {
      ...orgAuthed,
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(calls.del).toBe(1);
  });

  it("404s an unknown budget id", async () => {
    store.throwOnDelete = "NOT_FOUND";
    const res = await app.request("/v1/org/budgets/nope", {
      ...orgAuthed,
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
