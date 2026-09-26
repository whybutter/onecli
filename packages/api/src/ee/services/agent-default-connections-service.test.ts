import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory `@onecli/db` mock covering only what this service touches:
// `workspaceAgentDefaultConnection` (the template rows) and `appConnection`
// (pool membership + provider/metadata lookups). `setConnectionGrant` itself
// is mocked at the module boundary — its own behavior is proven by
// grants-service.test.ts; this file only proves the template CRUD and that
// `applyWorkspaceAgentDefaults` calls it correctly and tolerates a failure.

interface DefaultRow {
  workspaceId: string;
  connectionId: string;
  access: string;
  allow: string[];
  ask: string[];
  resources: unknown;
  createdByUserId: string | null;
}

interface ConnectionRow {
  id: string;
  workspaceId?: string;
  organizationId?: string;
  scope: string;
  provider: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
}

const store = vi.hoisted(() => ({
  defaults: [] as DefaultRow[],
  connections: [] as ConnectionRow[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: "JsonNull" },
  db: {
    appConnection: {
      findFirst: async ({
        where,
      }: {
        where: {
          id: string;
          OR: {
            workspaceId?: string;
            organizationId?: string;
            scope?: string;
          }[];
        };
      }) => {
        const conn = store.connections.find((c) => c.id === where.id);
        if (!conn) return null;
        const inPool = where.OR.some(
          (clause) =>
            (clause.workspaceId && conn.workspaceId === clause.workspaceId) ||
            (clause.organizationId &&
              conn.organizationId === clause.organizationId &&
              conn.scope === clause.scope),
        );
        return inPool ? conn : null;
      },
    },
    workspaceAgentDefaultConnection: {
      findMany: async ({ where }: { where: { workspaceId: string } }) =>
        store.defaults
          .filter((d) => d.workspaceId === where.workspaceId)
          .map((d) => ({
            ...d,
            connection: (() => {
              const c = store.connections.find((c) => c.id === d.connectionId)!;
              return { provider: c.provider, label: c.label, scope: c.scope };
            })(),
          })),
      deleteMany: async ({
        where,
      }: {
        where: { workspaceId: string; connectionId: string };
      }) => {
        const before = store.defaults.length;
        store.defaults = store.defaults.filter(
          (d) =>
            !(
              d.workspaceId === where.workspaceId &&
              d.connectionId === where.connectionId
            ),
        );
        return { count: before - store.defaults.length };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          workspaceId_connectionId: {
            workspaceId: string;
            connectionId: string;
          };
        };
        create: DefaultRow;
        update: Partial<DefaultRow>;
      }) => {
        const { workspaceId, connectionId } = where.workspaceId_connectionId;
        const existing = store.defaults.find(
          (d) =>
            d.workspaceId === workspaceId && d.connectionId === connectionId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        store.defaults.push(create);
        return create;
      },
    },
  },
}));

const setConnectionGrant = vi.fn(async () => ({
  grants: {
    agentId: "a1",
    mode: "grants" as const,
    connections: [],
    secrets: [],
  },
  changed: true,
  ruleIds: [],
  generation: null,
}));
vi.mock("../../services/grants-service", () => ({ setConnectionGrant }));

const assertToolIdsValid = vi.fn();
vi.mock("../../apps/app-permissions/validate", () => ({
  assertToolIdsValid: (...args: unknown[]) => assertToolIdsValid(...args),
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

const {
  listWorkspaceAgentDefaults,
  setWorkspaceAgentDefault,
  removeWorkspaceAgentDefault,
  applyWorkspaceAgentDefaults,
} = await import("./agent-default-connections-service");
const { ServiceError } = await import("../../services/errors");

const SCOPE = { workspaceId: "ws-1", organizationId: "org-1" };

beforeEach(() => {
  store.defaults = [];
  store.connections = [
    {
      id: "conn-workspace",
      workspaceId: "ws-1",
      scope: "workspace",
      provider: "github",
      label: "GitHub",
      metadata: null,
    },
    {
      id: "conn-org",
      organizationId: "org-1",
      scope: "organization",
      provider: "anthropic",
      label: "Anthropic",
      metadata: null,
    },
    {
      id: "conn-foreign",
      workspaceId: "ws-other",
      scope: "workspace",
      provider: "gmail",
      label: "Gmail",
      metadata: null,
    },
  ];
  setConnectionGrant.mockClear();
  assertToolIdsValid.mockClear();
});

describe("listWorkspaceAgentDefaults", () => {
  it("returns an empty template for a workspace with no defaults", async () => {
    expect(await listWorkspaceAgentDefaults(SCOPE)).toEqual([]);
  });

  it("projects the connection's provider/label/scope alongside the stored access", async () => {
    store.defaults = [
      {
        workspaceId: "ws-1",
        connectionId: "conn-workspace",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: "u1",
      },
    ];
    expect(await listWorkspaceAgentDefaults(SCOPE)).toEqual([
      {
        connectionId: "conn-workspace",
        provider: "github",
        label: "GitHub",
        scope: "workspace",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
      },
    ]);
  });
});

describe("setWorkspaceAgentDefault — the config surface", () => {
  it("rejects a connection outside the workspace's pool (not owned by the workspace, not org-shared)", async () => {
    await expect(
      setWorkspaceAgentDefault(
        SCOPE,
        "conn-foreign",
        { access: "full", resources: null },
        "u1",
      ),
    ).rejects.toThrow(ServiceError);
    expect(store.defaults).toHaveLength(0);
  });

  it("accepts an org-shared connection, not just a workspace-owned one — the attach pool spans both", async () => {
    await setWorkspaceAgentDefault(
      SCOPE,
      "conn-org",
      { access: "full", resources: null },
      "u1",
    );
    expect(store.defaults).toHaveLength(1);
    expect(store.defaults[0]!.connectionId).toBe("conn-org");
  });

  it("validates tool ids against the connection's catalog for custom access", async () => {
    await setWorkspaceAgentDefault(
      SCOPE,
      "conn-workspace",
      {
        access: "custom",
        allow: ["t-read"],
        ask: ["t-write"],
        resources: null,
      },
      "u1",
    );
    expect(assertToolIdsValid).toHaveBeenCalledWith("github", [
      "t-read",
      "t-write",
    ]);
  });

  it("upsert: a second call on the same connection replaces, not duplicates", async () => {
    await setWorkspaceAgentDefault(
      SCOPE,
      "conn-workspace",
      { access: "full", resources: null },
      "u1",
    );
    await setWorkspaceAgentDefault(
      SCOPE,
      "conn-workspace",
      { access: "custom", allow: ["t-read"], ask: [], resources: null },
      "u1",
    );
    expect(store.defaults).toHaveLength(1);
    expect(store.defaults[0]!.access).toBe("custom");
  });
});

describe("removeWorkspaceAgentDefault", () => {
  it("is a no-op when nothing matches", async () => {
    await expect(
      removeWorkspaceAgentDefault(SCOPE, "conn-workspace"),
    ).resolves.toBeUndefined();
  });

  it("removes an existing default", async () => {
    await setWorkspaceAgentDefault(
      SCOPE,
      "conn-workspace",
      { access: "full", resources: null },
      "u1",
    );
    await removeWorkspaceAgentDefault(SCOPE, "conn-workspace");
    expect(store.defaults).toHaveLength(0);
  });
});

describe("applyWorkspaceAgentDefaults — the create-time apply step", () => {
  it("calls setConnectionGrant once per default, with system attribution (userId null)", async () => {
    store.defaults = [
      {
        workspaceId: "ws-1",
        connectionId: "conn-workspace",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: "u1",
      },
      {
        workspaceId: "ws-1",
        connectionId: "conn-org",
        access: "custom",
        allow: ["t-read"],
        ask: [],
        resources: null,
        createdByUserId: "u1",
      },
    ];

    await applyWorkspaceAgentDefaults(SCOPE, "new-agent");

    expect(setConnectionGrant).toHaveBeenCalledTimes(2);
    expect(setConnectionGrant).toHaveBeenCalledWith(
      SCOPE,
      "new-agent",
      "conn-workspace",
      { access: "full", resources: null },
      null,
    );
    expect(setConnectionGrant).toHaveBeenCalledWith(
      SCOPE,
      "new-agent",
      "conn-org",
      { access: "custom", allow: ["t-read"], ask: [], resources: null },
      null,
    );
  });

  it("one connection's grant failing does not stop the rest — best-effort, never blocks agent creation", async () => {
    store.defaults = [
      {
        workspaceId: "ws-1",
        connectionId: "conn-workspace",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: null,
      },
      {
        workspaceId: "ws-1",
        connectionId: "conn-org",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: null,
      },
    ];
    setConnectionGrant.mockRejectedValueOnce(new Error("catalog drifted"));

    await expect(
      applyWorkspaceAgentDefaults(SCOPE, "new-agent"),
    ).resolves.toBeUndefined();
    expect(setConnectionGrant).toHaveBeenCalledTimes(2);
  });

  it("no defaults configured: applies nothing, resolves cleanly", async () => {
    await applyWorkspaceAgentDefaults(SCOPE, "new-agent");
    expect(setConnectionGrant).not.toHaveBeenCalled();
  });
});
