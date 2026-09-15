import { beforeEach, describe, expect, it, vi } from "vitest";

// The access law (api-ee-behaviour §2.3), Phase 0: direct bindings only.
// A hand-rolled @onecli/db double records every binding read so the ORDER
// invariant of the checker (role first, bindings never consulted for a
// non-member or an admin) is provable, not assumed.

interface MemberRow {
  organizationId: string;
  userId: string;
  role: string;
  status: string;
}

interface BindingRow {
  workspaceId: string;
  userId: string;
  role: string;
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  bindings: [] as BindingRow[],
  workspaces: [] as { id: string; organizationId: string }[],
  bindingReads: 0,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
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
    workspaceAccess: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; userId: string; role?: string };
      }) => {
        store.bindingReads += 1;
        const row = store.bindings.find(
          (b) =>
            b.workspaceId === where.workspaceId &&
            b.userId === where.userId &&
            (where.role === undefined || b.role === where.role),
        );
        return row ? { id: `${row.workspaceId}:${row.userId}` } : null;
      },
    },
    workspace: {
      // The visibility fence: the workspace must sit in an org the user is
      // an ACTIVE member of. The double evaluates that nested `some` by hand.
      findFirst: async ({
        where,
      }: {
        where: {
          id: string;
          organization: {
            members: { some: { userId: string; status: { not: string } } };
          };
        };
      }) => {
        const workspace = store.workspaces.find((w) => w.id === where.id);
        if (!workspace) return null;
        const probe = where.organization.members.some;
        const member = store.members.find(
          (m) =>
            m.organizationId === workspace.organizationId &&
            m.userId === probe.userId &&
            m.status !== probe.status.not,
        );
        return member ? { organizationId: workspace.organizationId } : null;
      },
    },
  },
}));

import {
  canAccessWorkspace,
  canManageAllWorkspaces,
  canManageWorkspace,
  eeWorkspaceAccessChecker,
  getUserRole,
  hasMinimumRole,
  requireRole,
  visibleWorkspacesWhere,
} from "./authorization-service";

const ORG = "org-1";
const WS = "ws-1";
// A sibling workspace in the same org, and a workspace in ANOTHER org where
// an admin of org-1 holds nothing — the fence the whole law hangs on.
const SIBLING_WS = "ws-2";
const OTHER_ORG = "org-b";
const OTHER_WS = "ws-b";
const member = (userId: string, role: string, status = "active") => ({
  organizationId: ORG,
  userId,
  role,
  status,
});

beforeEach(() => {
  store.members = [
    member("owner", "owner"),
    member("admin", "admin"),
    member("bound", "member"),
    member("manager", "member"),
    member("plain", "member"),
    member("suspended", "admin", "suspended"),
    {
      organizationId: OTHER_ORG,
      userId: "other-owner",
      role: "owner",
      status: "active",
    },
  ];
  store.bindings = [
    { workspaceId: WS, userId: "bound", role: "member" },
    { workspaceId: WS, userId: "manager", role: "owner" },
    // A stale binding: suspension must win over it.
    { workspaceId: WS, userId: "suspended", role: "owner" },
  ];
  store.workspaces = [
    { id: WS, organizationId: ORG },
    { id: SIBLING_WS, organizationId: ORG },
    { id: OTHER_WS, organizationId: OTHER_ORG },
  ];
  store.bindingReads = 0;
});

describe("hasMinimumRole", () => {
  it.each<[string | null, string, boolean]>([
    ["owner", "admin", true],
    ["admin", "admin", true],
    ["member", "admin", false],
    ["admin", "owner", false],
    ["owner", "owner", true],
    [null, "member", false],
  ])("%s ≥ %s → %s", (role, min, expected) => {
    expect(
      hasMinimumRole(
        role as "owner" | "admin" | "member" | null,
        min as "owner" | "admin" | "member",
      ),
    ).toBe(expected);
  });
});

describe("getUserRole (the suspension choke point)", () => {
  it("reads the active membership's role", async () => {
    await expect(getUserRole("admin", ORG)).resolves.toBe("admin");
    await expect(getUserRole("plain", ORG)).resolves.toBe("member");
  });

  it("answers null for a non-member", async () => {
    await expect(getUserRole("stranger", ORG)).resolves.toBeNull();
    await expect(getUserRole("owner", "org-other")).resolves.toBeNull();
  });

  it("answers null for a suspended member, whatever their role", async () => {
    await expect(getUserRole("suspended", ORG)).resolves.toBeNull();
    store.members.push(member("frozen-owner", "owner", "suspended"));
    await expect(getUserRole("frozen-owner", ORG)).resolves.toBeNull();
  });
});

describe("requireRole", () => {
  it("returns the role when it meets the threshold", async () => {
    await expect(requireRole("owner", ORG, "admin")).resolves.toBe("owner");
    await expect(requireRole("plain", ORG, "member")).resolves.toBe("member");
  });

  it("refuses a non-member and a suspended member as not a member", async () => {
    for (const userId of ["stranger", "suspended"]) {
      await expect(requireRole(userId, ORG, "member")).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Not a member of this organization",
      });
    }
  });

  it("refuses a member below the threshold", async () => {
    await expect(requireRole("plain", ORG, "admin")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Insufficient permissions",
    });
  });
});

describe("visibleWorkspacesWhere", () => {
  it("gives admins the whole org and members their bindings", () => {
    expect(visibleWorkspacesWhere("u", ORG, "admin")).toEqual({
      organizationId: ORG,
    });
    expect(visibleWorkspacesWhere("u", ORG, "member")).toEqual({
      organizationId: ORG,
      accessBindings: { some: { userId: "u" } },
    });
    expect(canManageAllWorkspaces(null)).toBe(false);
  });
});

describe("canAccessWorkspace (use)", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["bound", true],
    ["manager", true],
    ["plain", false],
    ["suspended", false],
    ["stranger", false],
  ])("%s → %s", async (userId, expected) => {
    await expect(canAccessWorkspace(userId, WS)).resolves.toBe(expected);
  });

  it("is false for a workspace that does not exist", async () => {
    await expect(canAccessWorkspace("owner", "ws-missing")).resolves.toBe(
      false,
    );
  });
});

describe("canManageWorkspace (rename / share / delete)", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["manager", true],
    // A plain use binding never confers management.
    ["bound", false],
    ["plain", false],
    ["suspended", false],
    ["stranger", false],
  ])("%s → %s", async (userId, expected) => {
    await expect(canManageWorkspace(userId, WS)).resolves.toBe(expected);
  });
});

describe("the org fence", () => {
  it("an owner/admin of org-1 has neither use nor management in org-b", async () => {
    for (const userId of ["owner", "admin"]) {
      await expect(canAccessWorkspace(userId, OTHER_WS)).resolves.toBe(false);
      await expect(canManageWorkspace(userId, OTHER_WS)).resolves.toBe(false);
    }
    expect(store.bindingReads).toBe(0);
  });

  it("the checker denies a foreign workspace even when the caller's own org id is supplied", async () => {
    // A (workspaceId, organizationId) pair that disagrees with the database
    // is the caller's bug; the checker answers for the org it was given, so
    // an org-1 admin asked about ws-b under org-1 is not admitted by ws-b's
    // org — and a member's binding lookup is keyed by the workspace, so a
    // sibling-org pair never leaks a binding either.
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("bound", {
        id: OTHER_WS,
        organizationId: ORG,
      }),
    ).resolves.toBe(false);
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("owner", {
        id: OTHER_WS,
        organizationId: OTHER_ORG,
      }),
    ).resolves.toBe(false);
  });

  it("a member bound on ws-1 reaches neither the sibling ws-2 nor its management", async () => {
    await expect(canAccessWorkspace("bound", WS)).resolves.toBe(true);
    await expect(canAccessWorkspace("bound", SIBLING_WS)).resolves.toBe(false);
    await expect(canManageWorkspace("bound", SIBLING_WS)).resolves.toBe(false);
    await expect(canManageWorkspace("manager", SIBLING_WS)).resolves.toBe(
      false,
    );
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("bound", {
        id: SIBLING_WS,
        organizationId: ORG,
      }),
    ).resolves.toBe(false);
  });

  it("the other org's owner sees only their own workspace", async () => {
    await expect(canAccessWorkspace("other-owner", OTHER_WS)).resolves.toBe(
      true,
    );
    await expect(canAccessWorkspace("other-owner", WS)).resolves.toBe(false);
    await expect(canManageWorkspace("other-owner", WS)).resolves.toBe(false);
  });
});

describe("eeWorkspaceAccessChecker (the shared-predicate slot)", () => {
  const ref = { id: WS, organizationId: ORG };

  it("admits an owner/admin without consulting bindings", async () => {
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("admin", ref),
    ).resolves.toBe(true);
    expect(store.bindingReads).toBe(0);
  });

  it("denies a suspended member with a stale binding, with zero binding reads", async () => {
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("suspended", ref),
    ).resolves.toBe(false);
    expect(store.bindingReads).toBe(0);
  });

  it("denies a non-member with zero binding reads", async () => {
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("stranger", ref),
    ).resolves.toBe(false);
    expect(store.bindingReads).toBe(0);
  });

  it("admits a member iff they hold a binding", async () => {
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("bound", ref),
    ).resolves.toBe(true);
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("plain", ref),
    ).resolves.toBe(false);
    expect(store.bindingReads).toBe(2);
  });

  it("userIsOrgAdmin: owner and admin pass, member and suspended admin fail", async () => {
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("owner", ORG),
    ).resolves.toBe(true);
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("admin", ORG),
    ).resolves.toBe(true);
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("plain", ORG),
    ).resolves.toBe(false);
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("suspended", ORG),
    ).resolves.toBe(false);
  });
});
