import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Org departure stays free ──────────────────────────────────────────────
//
// Ported from the retired `licensing/org-departure-free.test.ts`: a member
// (or an admin removing one) must always be able to shed a membership; the
// owner block is a domain rule; voluntary leave never revokes the login. The
// db is a recording proxy double: every model.method resolves a benign empty
// and is logged by name, with targeted overrides — what matters here is which
// steps run and in what order, not row plumbing.

const store = vi.hoisted(() => ({
  role: "member" as string,
  isMember: true,
  calls: [] as string[],
  personalWorkspaces: [] as { id: string; name: string | null }[],
  keys: [] as { id: string; key: string; userEmail: string }[],
  // The IdP-managed-role lock (changeMemberRole): true when the target sits
  // in a group carrying a role mapping.
  roleManagedByIdp: false,
}));

vi.mock("@onecli/db", () => {
  const record = (name: string, value: unknown) => async () => {
    store.calls.push(name);
    return value;
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (name === "organizationMember" && method === "findUnique") {
            return record(
              `${name}.findUnique`,
              store.isMember
                ? { role: store.role, userEmail: "leaver@example.com" }
                : null,
            );
          }
          if (name === "workspace" && method === "findMany") {
            return record(
              `${name}.findMany`,
              store.personalWorkspaces.map((w) => ({ ...w, agents: [] })),
            );
          }
          if (name === "apiKey" && method === "findMany") {
            return record(`${name}.findMany`, store.keys);
          }
          if (name === "groupMember" && method === "findFirst") {
            return record(
              `${name}.findFirst`,
              store.roleManagedByIdp ? { userId: "user-2" } : null,
            );
          }
          if (method === "count") return record(`${name}.count`, 1);
          if (method === "findMany") return record(`${name}.findMany`, []);
          if (method === "findFirst") return record(`${name}.findFirst`, null);
          return record(`${name}.${method}`, { count: 0 });
        },
      },
    );
  return {
    Prisma: {},
    db: new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === "$transaction"
            ? async (fn: (tx: unknown) => Promise<unknown>) =>
                fn(new Proxy({}, { get: (_x, m: string) => model(m) }))
            : model(name),
      },
    ),
  };
});

const flushed = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForKeys: (keys: string[]) => {
    flushed.keys.push(...keys);
  },
  invalidateGatewayCacheForOrg: () => {},
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCache: () => {},
}));

vi.mock("../../services/channels/agent-channel-service", () => ({
  teardownWorkspacePresences: async () => {},
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

import {
  changeMemberRole,
  findDeletablePersonalWorkspaces,
  listMembers,
  removeMember,
} from "./team-service";

beforeEach(() => {
  store.role = "member";
  store.isMember = true;
  store.calls = [];
  store.personalWorkspaces = [];
  store.keys = [];
  store.roleManagedByIdp = false;
  flushed.keys = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("removeMember", () => {
  it('voluntary leave completes and keeps the login — outcome "skipped"', async () => {
    await expect(
      removeMember("org-1", "user-2", { revokeIdentity: false }),
    ).resolves.toEqual({ revocation: "skipped", email: "leaver@example.com" });
    // The membership row actually went — departure worked, not just no-op'd.
    expect(store.calls).toContain("organizationMember.delete");
  });

  it("an admin removal completes too, with the same outcome in this build", async () => {
    await expect(removeMember("org-1", "user-2")).resolves.toEqual({
      revocation: "skipped",
      email: "leaver@example.com",
    });
    expect(store.calls).toContain("organizationMember.delete");
  });

  it("the owner cannot be removed — a domain rule, before any destructive step", async () => {
    store.role = "owner";
    await expect(removeMember("org-1", "user-2")).rejects.toThrow(
      "The organization owner cannot be removed",
    );
    expect(store.calls).not.toContain("organizationMember.delete");
    expect(store.calls).not.toContain("workspaceAccess.deleteMany");
  });

  it("a non-member reads as a plain error, and nothing is deleted", async () => {
    store.isMember = false;
    await expect(removeMember("org-1", "ghost")).rejects.toThrow(
      "User is not a member of this organization",
    );
    expect(store.calls).toEqual(["organizationMember.findUnique"]);
  });

  it("deletes the leaver's truly-personal workspaces and revokes their keys before the row", async () => {
    store.personalWorkspaces = [{ id: "ws-mine", name: "Mine" }];
    store.keys = [{ id: "k1", key: "oc_leaver", userEmail: "l@example.com" }];
    await removeMember("org-1", "user-2");

    const order = (name: string) => store.calls.indexOf(name);
    // The personal workspace cascade ran (its row delete) …
    expect(store.calls).toContain("workspace.delete");
    // … the keys were revoked, flushed and audited under the leaver …
    expect(store.calls).toContain("apiKey.deleteMany");
    expect(flushed.keys).toContain("oc_leaver");
    expect(store.calls).toContain("auditLog.create");
    // … their shared-in bindings and group memberships in this org went …
    expect(store.calls).toContain("workspaceAccess.deleteMany");
    expect(store.calls).toContain("groupMember.deleteMany");
    // … and the membership row went last.
    expect(order("organizationMember.delete")).toBeGreaterThan(
      order("workspace.delete"),
    );
    expect(order("organizationMember.delete")).toBeGreaterThan(
      order("workspaceAccess.deleteMany"),
    );
  });
});

describe("changeMemberRole", () => {
  it("rejects roles outside admin/member", async () => {
    await expect(changeMemberRole("org-1", "user-2", "owner")).rejects.toThrow(
      "Invalid role",
    );
    await expect(changeMemberRole("org-1", "user-2", "root")).rejects.toThrow(
      "Invalid role",
    );
  });

  it("never changes the owner's role", async () => {
    store.role = "owner";
    await expect(changeMemberRole("org-1", "user-2", "member")).rejects.toThrow(
      "The owner's role cannot be changed",
    );
    expect(store.calls).not.toContain("organizationMember.update");
  });

  it("promotes without touching keys, demotes with key revocation", async () => {
    await changeMemberRole("org-1", "user-2", "admin");
    expect(store.calls).toContain("organizationMember.update");
    expect(store.calls).not.toContain("apiKey.deleteMany");

    store.calls = [];
    store.role = "admin";
    store.keys = [{ id: "k1", key: "oc_shared", userEmail: "u@example.com" }];
    await changeMemberRole("org-1", "user-2", "member");
    expect(store.calls).toContain("organizationMember.update");
    expect(store.calls).toContain("apiKey.deleteMany");
    expect(flushed.keys).toEqual(["oc_shared"]);
  });

  it("refuses a role change for an IdP-managed member, owner guard first", async () => {
    store.roleManagedByIdp = true;
    await expect(
      changeMemberRole("org-1", "user-2", "admin"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This member's role is managed by your identity provider.",
    });
    expect(store.calls).not.toContain("organizationMember.update");

    // The owner guard still fires BEFORE the IdP lock even when both would
    // refuse — an owner can never be "IdP-managed" per spec §4.4.
    store.calls = [];
    store.role = "owner";
    await expect(changeMemberRole("org-1", "user-2", "member")).rejects.toThrow(
      "The owner's role cannot be changed",
    );
  });

  it("allows an unmapped member's role change even with the lock wired", async () => {
    store.roleManagedByIdp = false;
    await expect(
      changeMemberRole("org-1", "user-2", "admin"),
    ).resolves.toBeUndefined();
    expect(store.calls).toContain("organizationMember.update");
  });
});

describe("the free reads", () => {
  it("listMembers answers — the team page's only data source", async () => {
    await expect(listMembers("org-1")).resolves.toEqual([]);
  });

  it("findDeletablePersonalWorkspaces answers — the leave dialog's warning", async () => {
    store.personalWorkspaces = [{ id: "ws-mine", name: "Mine" }];
    await expect(
      findDeletablePersonalWorkspaces("org-1", "user-2"),
    ).resolves.toEqual([{ id: "ws-mine", name: "Mine", channelApps: [] }]);
  });
});
