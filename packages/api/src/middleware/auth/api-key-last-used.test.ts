import { beforeEach, describe, expect, it, vi } from "vitest";

// `lastUsedAt` through the REAL app — the real `auth()` middleware, the real
// workspace/org gates.
//
// A leaked key is only detectable if this column tracks *authentication*, so
// the suite is written around that word: every request that resolves to a
// caller records, every request that does not resolve to one records nothing,
// and a key in constant use writes at most once per throttle window. The
// last two must never regress — a write on failed auth turns the column into
// a log of bearer strings someone guessed, and a write per request puts the
// database on the hot path of every gateway call.

const USER = "user-1";
const ORG = "org-1";
const WORKSPACE = "ws-1";
const WORKSPACE_KEY = "oc_workspace-key";
const ORG_KEY = "oc_org_key";
const WORKSPACE_KEY_ID = "key-workspace-1";
const ORG_KEY_ID = "key-org-1";

const state = vi.hoisted(() => ({
  member: { role: "owner", status: "active" } as {
    role: string;
    status: string;
  } | null,
  /** The stored column, mutated by the write so the throttle is observable. */
  lastUsedAt: {} as Record<string, Date | null>,
}));

const updateMany = vi.hoisted(() =>
  vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { lastUsedAt: Date };
    }) => {
      state.lastUsedAt[where.id] = data.lastUsedAt;
      return { count: 1 };
    },
  ),
);

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === ORG_KEY)
          return {
            id: ORG_KEY_ID,
            key: ORG_KEY,
            userId: USER,
            organizationId: ORG,
            scope: "organization",
            lastUsedAt: state.lastUsedAt[ORG_KEY_ID] ?? null,
          };
        if (where.key === WORKSPACE_KEY)
          return {
            id: WORKSPACE_KEY_ID,
            key: WORKSPACE_KEY,
            userId: USER,
            workspaceId: WORKSPACE,
            kind: "user",
            lastUsedAt: state.lastUsedAt[WORKSPACE_KEY_ID] ?? null,
          };
        return null;
      },
      findFirst: async () => null,
      findMany: async () => [],
      updateMany,
    },
    user: {
      findUnique: async () => ({
        id: USER,
        email: "user@example.com",
        name: null,
        createdAt: new Date(),
      }),
    },
    organizationMember: {
      findUnique: async () => state.member,
      findFirst: async () =>
        state.member ? { organizationId: ORG } : null,
    },
    workspace: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id === WORKSPACE
          ? { id: WORKSPACE, organizationId: ORG }
          : null,
      findFirst: async ({ where }: { where?: { id?: string } }) =>
        where?.id === undefined || where.id === WORKSPACE
          ? { id: WORKSPACE, organizationId: ORG }
          : null,
    },
    workspaceAccess: { findFirst: async () => null },
    agent: { findMany: async () => [] },
    requestLog: { groupBy: async () => [] },
  },
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

const { createApiApp } = await import("../../app");
const { getUserRole } = await import(
  "../../ee/services/authorization-service"
);
const { initStrictApiKeyAuth } = await import("../../providers");

const app = createApiApp(
  { getSession: async () => null },
  { roleResolver: { getUserRole } },
);

const bearer = (key: string, extra: Record<string, string> = {}) => ({
  headers: { Authorization: `Bearer ${key}`, ...extra },
});

const touchedIds = () =>
  updateMany.mock.calls.map((call) => call[0].where.id as string);

beforeEach(() => {
  state.member = { role: "owner", status: "active" };
  state.lastUsedAt = {};
  updateMany.mockClear();
  initStrictApiKeyAuth(false);
});

describe("a successful authentication records the key", () => {
  it("stamps a workspace key that authenticates", async () => {
    const res = await app.request("/v1/user", bearer(WORKSPACE_KEY));

    expect(res.status).toBe(200);
    expect(touchedIds()).toEqual([WORKSPACE_KEY_ID]);
    expect(state.lastUsedAt[WORKSPACE_KEY_ID]).toBeInstanceOf(Date);
  });

  it("stamps an org key that authenticates", async () => {
    const res = await app.request("/v1/user", bearer(ORG_KEY));

    expect(res.status).toBe(200);
    expect(touchedIds()).toEqual([ORG_KEY_ID]);
  });

  it("stamps an org key scoped to a workspace inside its org", async () => {
    const res = await app.request(
      "/v1/user",
      bearer(ORG_KEY, { "x-workspace-id": WORKSPACE }),
    );

    expect(res.status).toBe(200);
    expect(touchedIds()).toEqual([ORG_KEY_ID]);
  });
});

describe("a failed authentication records nothing", () => {
  it("records nothing for a key that does not exist", async () => {
    const res = await app.request("/v1/user", bearer("oc_nope"));

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  // The demotion gate. The key is real and the row was read — recording here
  // would report a revoked holder as an active user of the key.
  it("records nothing for a real org key whose holder lost admin", async () => {
    state.member = { role: "member", status: "active" };

    const res = await app.request("/v1/user", bearer(ORG_KEY));

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("records nothing for a suspended holder", async () => {
    state.member = { role: "owner", status: "suspended" };

    const res = await app.request("/v1/user", bearer(ORG_KEY));

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("records nothing when an org key names a workspace outside its org", async () => {
    const res = await app.request(
      "/v1/user",
      bearer(ORG_KEY, { "x-workspace-id": "ws-2" }),
    );

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  // A valid bearer that never resolved to a caller. The credential checked
  // out, but no authentication completed — `lastUsedAt` answers the second
  // question, not the first. Exercised directly against `authenticateApiKey`
  // (rather than through a full route) so the assertion doesn't depend on
  // which route happens to set `requireWorkspace: true`.
  it("records nothing when a valid org key omits the workspace header and a workspace is required", async () => {
    const { authenticateApiKey } = await import("./api-key");
    const result = await authenticateApiKey(
      new Request("http://x", {
        headers: { authorization: `Bearer ${ORG_KEY}` },
      }),
      /* requireWorkspace */ true,
    );

    expect(result).toBe("missing-workspace");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("records nothing for a request carrying no API key at all", async () => {
    const res = await app.request("/v1/user");

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("the throttle keeps the write off the per-request path", () => {
  it("writes ONCE across a burst of authenticated requests", async () => {
    for (let i = 0; i < 25; i++) {
      const res = await app.request("/v1/user", bearer(WORKSPACE_KEY));
      expect(res.status).toBe(200);
    }

    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("writes again once the stored value has aged out of the window", async () => {
    await app.request("/v1/user", bearer(WORKSPACE_KEY));
    expect(updateMany).toHaveBeenCalledTimes(1);

    const { API_KEY_LAST_USED_THROTTLE_MS } = await import(
      "../../services/api-key-service"
    );
    state.lastUsedAt[WORKSPACE_KEY_ID] = new Date(
      Date.now() - API_KEY_LAST_USED_THROTTLE_MS - 1000,
    );

    await app.request("/v1/user", bearer(WORKSPACE_KEY));
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("throttles each key independently", async () => {
    await app.request("/v1/user", bearer(WORKSPACE_KEY));
    await app.request("/v1/user", bearer(ORG_KEY));
    await app.request("/v1/user", bearer(WORKSPACE_KEY));

    expect(touchedIds()).toEqual([WORKSPACE_KEY_ID, ORG_KEY_ID]);
  });
});

describe("authentication outcomes are unchanged by the recording", () => {
  it("still authenticates when the usage write fails outright", async () => {
    updateMany.mockRejectedValueOnce(new Error("connection reset"));

    const res = await app.request("/v1/user", bearer(WORKSPACE_KEY));

    expect(res.status).toBe(200);
  });
});
