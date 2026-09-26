import { beforeEach, describe, expect, it, vi } from "vitest";

// The directory-scale additions to team-service.ts: the `/org/members` page
// (api-ee-behaviour §1.2/§0.4), suspend/reinstate/ssoExempt, the create-by-
// email door, and the user→groups page. A hand-rolled @onecli/db double
// tailored to the exact query shapes these functions build (not a generic
// Prisma engine) — see `group-service.test.ts` for the sibling group-side
// coverage these functions delegate `groupsFor` to.

interface MemberRow {
  organizationId: string;
  userId: string;
  userEmail: string;
  role: string;
  status: string;
  ssoExempt: boolean;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  groups: [] as { id: string; organizationId: string; name: string }[],
  createdUsers: [] as UserRow[],
  createdMembers: [] as MemberRow[],
}));

interface OrgMemberWhere {
  organizationId: string;
  userEmail?: string;
  NOT?: { userEmail: { endsWith: string } };
  status?: string;
  OR?: (
    | { userEmail: { contains: string; mode: string } }
    | { user: { name: { contains: string; mode: string } } }
  )[];
  AND?: {
    OR: (
      | { createdAt: { gt: Date } }
      | { createdAt: Date; userId: { gt: string } }
    )[];
  }[];
}

const matchesQFilter = (row: MemberRow, or: OrgMemberWhere["OR"]): boolean => {
  if (!or) return true;
  return or.some((clause) => {
    if ("userEmail" in clause) {
      return row.userEmail
        .toLowerCase()
        .includes(clause.userEmail.contains.toLowerCase());
    }
    const user = store.users.find((u) => u.id === row.userId);
    return (user?.name ?? "")
      .toLowerCase()
      .includes(clause.user.name.contains.toLowerCase());
  });
};

const matchesCursor = (row: MemberRow, and: OrgMemberWhere["AND"]): boolean => {
  if (!and) return true;
  return and.every(({ OR }) =>
    OR.some((clause) =>
      "userId" in clause
        ? row.createdAt.getTime() === clause.createdAt.getTime() &&
          row.userId > clause.userId.gt
        : row.createdAt.getTime() > clause.createdAt.gt.getTime(),
    ),
  );
};

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    organizationMember: {
      findMany: async ({ where }: { where: OrgMemberWhere }) =>
        store.members
          .filter((m) => m.organizationId === where.organizationId)
          .filter(
            (m) =>
              !where.NOT || !m.userEmail.endsWith(where.NOT.userEmail.endsWith),
          )
          .filter((m) => !where.status || m.status === where.status)
          .filter((m) => matchesQFilter(m, where.OR))
          .filter((m) => matchesCursor(m, where.AND))
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.userId.localeCompare(b.userId),
          )
          .map((m) => ({
            userId: m.userId,
            userEmail: m.userEmail,
            role: m.role,
            status: m.status,
            ssoExempt: m.ssoExempt,
            createdAt: m.createdAt,
            user: store.users.find((u) => u.id === m.userId) ?? null,
          })),
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string; userEmail: string };
      }) =>
        store.members.find(
          (m) =>
            m.organizationId === where.organizationId &&
            m.userEmail === where.userEmail,
        ) ?? null,
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
      update: async ({
        where,
        data,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
        data: Partial<MemberRow>;
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        const row = store.members.find(
          (m) => m.organizationId === organizationId && m.userId === userId,
        );
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: MemberRow }) => {
        const row = { ...data, createdAt: new Date("2026-01-01") };
        store.members.push(row);
        store.createdMembers.push(row);
        return row;
      },
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        store.users.find((u) => u.email === where.email) ?? null,
      create: async ({
        data,
      }: {
        data: { email: string; name: string | null };
      }) => {
        const row = { id: `new-${store.users.length + 1}`, ...data };
        store.users.push(row);
        store.createdUsers.push(row);
        return row;
      },
    },
    group: {
      findMany: async ({
        where,
      }: {
        where: {
          organizationId: string;
          members: { some: { userId: string } };
        };
      }) =>
        store.groups
          .filter((g) => g.organizationId === where.organizationId)
          .filter((g) =>
            // Membership is fixtured per-test via the group id encoding
            // "grp-<userId>" so this double stays tiny.
            g.id.endsWith(where.members.some.userId),
          )
          .map((g) => ({
            id: g.id,
            name: g.name,
            source: "manual",
            externalId: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            _count: { members: 1 },
          })),
    },
  },
}));

import {
  createMember,
  groupsFor,
  listMembersPage,
  reinstateMember,
  setMemberSsoExempt,
  suspendMember,
} from "./team-service";

const ORG = "org-1";

const seedMember = (
  userId: string,
  overrides: Partial<MemberRow> = {},
): MemberRow => ({
  organizationId: ORG,
  userId,
  userEmail: `${userId}@example.com`,
  role: "member",
  status: "active",
  ssoExempt: false,
  createdAt: new Date("2026-01-01"),
  ...overrides,
});

beforeEach(() => {
  store.members = [];
  store.users = [];
  store.groups = [];
  store.createdUsers = [];
  store.createdMembers = [];
});

describe("listMembersPage", () => {
  it("orders by (createdAt asc, userId asc), placeholders excluded", async () => {
    store.members = [
      seedMember("b", { createdAt: new Date("2026-01-02") }),
      seedMember("a", { createdAt: new Date("2026-01-01") }),
      seedMember("ghost", {
        userEmail: "ghost@onecli.internal",
        createdAt: new Date("2026-01-01"),
      }),
    ];
    const page = await listMembersPage(ORG);
    expect(page.data.map((m) => m.userId)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBeNull();
  });

  it("filters by status", async () => {
    store.members = [
      seedMember("active-1", { status: "active" }),
      seedMember("suspended-1", { status: "suspended" }),
    ];
    const page = await listMembersPage(ORG, { status: "suspended" });
    expect(page.data.map((m) => m.userId)).toEqual(["suspended-1"]);
  });

  it("q is a case-insensitive contains over email OR display name", async () => {
    store.users = [{ id: "u1", email: "u1@example.com", name: "Ada Lovelace" }];
    store.members = [
      seedMember("u1", { userEmail: "u1@example.com" }),
      seedMember("u2", { userEmail: "someone@example.com" }),
    ];
    await expect(
      listMembersPage(ORG, { q: "lovelace" }).then((p) =>
        p.data.map((m) => m.userId),
      ),
    ).resolves.toEqual(["u1"]);
    await expect(
      listMembersPage(ORG, { q: "SOMEONE" }).then((p) =>
        p.data.map((m) => m.userId),
      ),
    ).resolves.toEqual(["u2"]);
  });

  it("paginates with limit+1 and a decodable nextCursor", async () => {
    store.members = [
      seedMember("a", { createdAt: new Date("2026-01-01") }),
      seedMember("b", { createdAt: new Date("2026-01-02") }),
      seedMember("c", { createdAt: new Date("2026-01-03") }),
    ];
    const page1 = await listMembersPage(ORG, { limit: 2 });
    expect(page1.data.map((m) => m.userId)).toEqual(["a", "b"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listMembersPage(ORG, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.data.map((m) => m.userId)).toEqual(["c"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("a malformed cursor is a BAD_REQUEST 'Invalid cursor', never a silent reset", async () => {
    await expect(
      listMembersPage(ORG, { cursor: "not-base64url-json" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invalid cursor" });
  });
});

describe("createMember", () => {
  it("creates a NEW user and an active member membership", async () => {
    const result = await createMember(ORG, "new@example.com", "New Person");
    expect(result).toMatchObject({
      email: "new@example.com",
      name: "New Person",
      role: "member",
      status: "active",
      userCreated: true,
    });
    expect(store.createdUsers).toHaveLength(1);
    expect(store.createdUsers[0]?.email).toBe("new@example.com");
    // A manual, non-directory placeholder id — the shared convention.
    expect(store.createdMembers[0]?.userId).toBe(result.userId);
  });

  it("reuses an EXISTING user by email, userCreated: false", async () => {
    store.users = [
      { id: "existing-1", email: "existing@example.com", name: "Existing" },
    ];
    const result = await createMember(ORG, "existing@example.com", null);
    expect(result).toMatchObject({
      userId: "existing-1",
      name: "Existing",
      userCreated: false,
    });
    expect(store.createdUsers).toHaveLength(0);
  });

  it("409s when the email already belongs to a member of this org", async () => {
    store.members = [seedMember("u1", { userEmail: "dupe@example.com" })];
    await expect(
      createMember(ORG, "dupe@example.com", null),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This user is already a member of the organization.",
    });
  });
});

describe("suspendMember", () => {
  it("suspends an active member", async () => {
    store.members = [seedMember("u1")];
    const result = await suspendMember(ORG, "u1", "actor-1");
    expect(result).toEqual({
      userId: "u1",
      status: "suspended",
      ssoExempt: false,
      revocation: "skipped",
    });
    expect(store.members[0]?.status).toBe("suspended");
  });

  it("refuses self-suspension before any write", async () => {
    store.members = [seedMember("actor-1")];
    await expect(
      suspendMember(ORG, "actor-1", "actor-1"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "You cannot suspend yourself",
    });
    expect(store.members[0]?.status).toBe("active");
  });

  it("404s a non-member", async () => {
    await expect(suspendMember(ORG, "ghost", "actor-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses to suspend the owner", async () => {
    store.members = [seedMember("owner-1", { role: "owner" })];
    await expect(
      suspendMember(ORG, "owner-1", "actor-1"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The organization owner cannot be suspended",
    });
  });

  it("409s an already-suspended member", async () => {
    store.members = [seedMember("u1", { status: "suspended" })];
    await expect(suspendMember(ORG, "u1", "actor-1")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This member is already suspended",
    });
  });
});

describe("reinstateMember", () => {
  it("reinstates a suspended member", async () => {
    store.members = [seedMember("u1", { status: "suspended" })];
    const result = await reinstateMember(ORG, "u1");
    expect(result).toEqual({
      userId: "u1",
      status: "active",
      ssoExempt: false,
      revocation: "skipped",
    });
    expect(store.members[0]?.status).toBe("active");
  });

  it("404s a non-member", async () => {
    await expect(reinstateMember(ORG, "ghost")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("409s a member who is not suspended", async () => {
    store.members = [seedMember("u1", { status: "active" })];
    await expect(reinstateMember(ORG, "u1")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This member is not suspended",
    });
  });
});

describe("setMemberSsoExempt", () => {
  it("writes the flag and echoes the membership status", async () => {
    store.members = [seedMember("u1", { status: "active", ssoExempt: false })];
    await expect(setMemberSsoExempt(ORG, "u1", true)).resolves.toEqual({
      userId: "u1",
      status: "active",
      ssoExempt: true,
    });
    expect(store.members[0]?.ssoExempt).toBe(true);
  });

  it("404s a non-member", async () => {
    await expect(setMemberSsoExempt(ORG, "ghost", true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("groupsFor", () => {
  it("delegates to the group directory, org- and user-fenced", async () => {
    store.groups = [
      { id: "grp-u1", organizationId: ORG, name: "Engineering" },
      { id: "grp-other-user", organizationId: ORG, name: "Sales" },
      { id: "grp-u1", organizationId: "org-2", name: "Cross-org" },
    ];
    const page = await groupsFor(ORG, "u1");
    expect(page.data.map((g) => g.name)).toEqual(["Engineering"]);
  });

  it("an unknown user reads as an empty page, never a 404", async () => {
    await expect(groupsFor(ORG, "nobody")).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
  });
});
