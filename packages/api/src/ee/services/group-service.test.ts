import { beforeEach, describe, expect, it, vi } from "vitest";

// The org's human-group directory (api-ee-behaviour §4.2/§4.6): list/create/
// rename/delete, the SCIM lock on every manual mutation, and the three
// membership writers. A hand-rolled @onecli/db double tailored to the exact
// query shapes `group-service.ts` builds.

interface GroupRecord {
  id: string;
  organizationId: string;
  name: string;
  source: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GroupMemberRecord {
  groupId: string;
  userId: string;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  groups: [] as GroupRecord[],
  groupMembers: [] as GroupMemberRecord[],
  orgMembers: [] as { organizationId: string; userId: string }[],
  users: [] as { id: string; email: string; name: string | null }[],
  nameUniqueViolation: false,
}));

const memberCount = (groupId: string) =>
  store.groupMembers.filter((m) => m.groupId === groupId).length;

const groupSelectShape = (g: GroupRecord) => ({
  id: g.id,
  name: g.name,
  source: g.source,
  externalId: g.externalId,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
  _count: { members: memberCount(g.id) },
});

interface GroupWhere {
  organizationId?: string;
  source?: string;
  name?: string | { contains: string; mode: string; not?: string };
  id?: string | { in: string[] };
  members?: { some: { userId: string } };
  AND?: unknown[];
}

const matchesGroup = (g: GroupRecord, where: GroupWhere): boolean => {
  if (
    where.organizationId !== undefined &&
    g.organizationId !== where.organizationId
  ) {
    return false;
  }
  if (where.source !== undefined && g.source !== where.source) return false;
  if (typeof where.name === "string" && g.name !== where.name) return false;
  if (
    where.name &&
    typeof where.name === "object" &&
    "contains" in where.name &&
    !g.name.toLowerCase().includes(where.name.contains.toLowerCase())
  ) {
    return false;
  }
  if (where.id !== undefined) {
    if (typeof where.id === "string" && g.id !== where.id) return false;
    if (typeof where.id === "object" && !where.id.in.includes(g.id)) {
      return false;
    }
  }
  if (
    where.members &&
    !store.groupMembers.some(
      (m) => m.groupId === g.id && m.userId === where.members!.some.userId,
    )
  ) {
    return false;
  }
  return true;
};

/** Flattens the `{ AND: [where, { OR: [...cursor...] }] }` shape the cursor
 * path wraps queries in, applying the base filter and the cursor keyset. */
const matchesWithCursor = (g: GroupRecord, where: GroupWhere): boolean => {
  if (!where.AND) return matchesGroup(g, where);
  const [base, cursorClause] = where.AND as [
    GroupWhere,
    { OR: ({ name: { gt: string } } | { name: string; id: { gt: string } })[] },
  ];
  if (!matchesGroup(g, base)) return false;
  return cursorClause.OR.some((clause) =>
    "id" in clause
      ? g.name === clause.name && g.id > clause.id.gt
      : g.name > clause.name.gt,
  );
};

vi.mock("@onecli/db", () => {
  const groupMemberModel = {
    findMany: async ({ where }: { where: { groupId: string } }) =>
      store.groupMembers
        .filter((m) => m.groupId === where.groupId)
        .map((m) => ({
          userId: m.userId,
          createdAt: m.createdAt,
          user: store.users.find((u) => u.id === m.userId) ?? {
            email: "",
            name: null,
          },
        })),
    findUnique: async ({
      where,
    }: {
      where: { groupId_userId: { groupId: string; userId: string } };
    }) =>
      store.groupMembers.find(
        (m) =>
          m.groupId === where.groupId_userId.groupId &&
          m.userId === where.groupId_userId.userId,
      ) ?? null,
    create: async ({ data }: { data: { groupId: string; userId: string } }) => {
      const row = { ...data, createdAt: new Date("2026-01-01") };
      store.groupMembers.push(row);
      return row;
    },
    createMany: async ({
      data,
    }: {
      data: { groupId: string; userId: string }[];
    }) => {
      for (const d of data) {
        if (
          !store.groupMembers.some(
            (m) => m.groupId === d.groupId && m.userId === d.userId,
          )
        ) {
          store.groupMembers.push({ ...d, createdAt: new Date("2026-01-01") });
        }
      }
      return { count: data.length };
    },
    deleteMany: async ({
      where,
    }: {
      where: { groupId: string; userId?: string | { in: string[] } };
    }) => {
      const before = store.groupMembers.length;
      store.groupMembers = store.groupMembers.filter((m) => {
        if (m.groupId !== where.groupId) return true;
        if (where.userId === undefined) return false;
        if (typeof where.userId === "string") return m.userId !== where.userId;
        return !where.userId.in.includes(m.userId);
      });
      return { count: before - store.groupMembers.length };
    },
  };

  return {
    Prisma: {},
    db: {
      group: {
        findMany: async ({ where }: { where: GroupWhere }) =>
          store.groups
            .filter((g) => matchesWithCursor(g, where))
            .sort(
              (a, b) =>
                a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
            )
            .map(groupSelectShape),
        findFirst: async ({ where }: { where: GroupWhere }) => {
          const row = store.groups.find((g) => matchesGroup(g, where));
          return row ? groupSelectShape(row) : null;
        },
        create: async ({
          data,
        }: {
          data: { organizationId: string; name: string; source: string };
        }) => {
          if (
            store.nameUniqueViolation ||
            store.groups.some(
              (g) =>
                g.organizationId === data.organizationId &&
                g.name === data.name,
            )
          ) {
            throw { code: "P2002" };
          }
          const row: GroupRecord = {
            id: `grp-${store.groups.length + 1}`,
            externalId: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            ...data,
          };
          store.groups.push(row);
          return groupSelectShape(row);
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; organizationId: string };
          data: Partial<GroupRecord>;
        }) => {
          const row = store.groups.find(
            (g) =>
              g.id === where.id && g.organizationId === where.organizationId,
          );
          if (!row) return { count: 0 };
          if (
            data.name &&
            store.groups.some(
              (g) =>
                g.id !== row.id &&
                g.organizationId === row.organizationId &&
                g.name === data.name,
            )
          ) {
            throw { code: "P2002" };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
        deleteMany: async ({
          where,
        }: {
          where: { id: string; organizationId: string };
        }) => {
          const before = store.groups.length;
          store.groups = store.groups.filter(
            (g) =>
              !(g.id === where.id && g.organizationId === where.organizationId),
          );
          return { count: before - store.groups.length };
        },
      },
      groupMember: groupMemberModel,
      organizationMember: {
        findMany: async ({
          where,
        }: {
          where: { organizationId: string; userId: { in: string[] } };
        }) =>
          store.orgMembers.filter(
            (m) =>
              m.organizationId === where.organizationId &&
              where.userId.in.includes(m.userId),
          ),
        findFirst: async ({
          where,
        }: {
          where: { organizationId: string; userId: string };
        }) =>
          store.orgMembers.find(
            (m) =>
              m.organizationId === where.organizationId &&
              m.userId === where.userId,
          ) ?? null,
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ groupMember: groupMemberModel }),
    },
  };
});

import {
  addOrgGroupMember,
  createOrgGroup,
  deleteOrgGroup,
  getOrgGroup,
  listOrgGroupMembers,
  listOrgGroups,
  removeOrgGroupMember,
  renameOrgGroup,
  setOrgGroupMembers,
} from "./group-service";

const ORG = "org-1";

beforeEach(() => {
  store.groups = [];
  store.groupMembers = [];
  store.orgMembers = [];
  store.users = [];
  store.nameUniqueViolation = false;
});

const seedGroup = (
  id: string,
  overrides: Partial<GroupRecord> = {},
): GroupRecord => ({
  id,
  organizationId: ORG,
  name: id,
  source: "manual",
  externalId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...overrides,
});

describe("listOrgGroups", () => {
  it("orders by (name asc, id asc), q is case-insensitive contains, source filters", async () => {
    store.groups = [
      seedGroup("g1", { name: "Sales" }),
      seedGroup("g2", { name: "Engineering" }),
      seedGroup("g3", { name: "Engineering Interns", source: "scim" }),
    ];
    const page = await listOrgGroups(ORG);
    expect(page.data.map((g) => g.name)).toEqual([
      "Engineering",
      "Engineering Interns",
      "Sales",
    ]);

    await expect(
      listOrgGroups(ORG, { q: "engineering" }).then((p) =>
        p.data.map((g) => g.id),
      ),
    ).resolves.toEqual(["g2", "g3"]);

    await expect(
      listOrgGroups(ORG, { source: "scim" }).then((p) =>
        p.data.map((g) => g.id),
      ),
    ).resolves.toEqual(["g3"]);
  });

  it("cross-org groups never appear", async () => {
    store.groups = [seedGroup("g1", { organizationId: "org-2" })];
    await expect(listOrgGroups(ORG)).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
  });

  it("a malformed cursor is a BAD_REQUEST 'Invalid cursor'", async () => {
    await expect(
      listOrgGroups(ORG, { cursor: "garbage" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invalid cursor" });
  });
});

describe("createOrgGroup", () => {
  it("creates a manual group with memberCount 0", async () => {
    const group = await createOrgGroup(ORG, "Engineering");
    expect(group).toMatchObject({
      name: "Engineering",
      source: "manual",
      externalId: null,
      memberCount: 0,
    });
  });

  it("409s on a duplicate name", async () => {
    store.groups = [seedGroup("g1", { name: "Engineering" })];
    await expect(createOrgGroup(ORG, "Engineering")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A group with this name already exists.",
    });
  });
});

describe("getOrgGroup / cross-org fencing", () => {
  it("404s an unknown or cross-org group id", async () => {
    store.groups = [seedGroup("g1", { organizationId: "org-2" })];
    await expect(getOrgGroup(ORG, "g1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getOrgGroup(ORG, "nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("renameOrgGroup", () => {
  it("renames a manual group", async () => {
    store.groups = [seedGroup("g1", { name: "Old" })];
    const renamed = await renameOrgGroup(ORG, "g1", "New");
    expect(renamed.name).toBe("New");
  });

  it("409s the SCIM lock on a scim-sourced group", async () => {
    store.groups = [seedGroup("g1", { source: "scim" })];
    await expect(renameOrgGroup(ORG, "g1", "New")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This group is managed by your identity provider.",
    });
  });

  it("409s a name conflict", async () => {
    store.groups = [
      seedGroup("g1", { name: "A" }),
      seedGroup("g2", { name: "B" }),
    ];
    await expect(renameOrgGroup(ORG, "g1", "B")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A group with this name already exists.",
    });
  });
});

describe("deleteOrgGroup", () => {
  it("deletes a manual group", async () => {
    store.groups = [seedGroup("g1")];
    const deleted = await deleteOrgGroup(ORG, "g1");
    expect(deleted).toEqual({ id: "g1", name: "g1" });
    expect(store.groups).toHaveLength(0);
  });

  it("409s the SCIM lock", async () => {
    store.groups = [seedGroup("g1", { source: "scim" })];
    await expect(deleteOrgGroup(ORG, "g1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(store.groups).toHaveLength(1);
  });

  it("404s a cross-org id", async () => {
    store.groups = [seedGroup("g1", { organizationId: "org-2" })];
    await expect(deleteOrgGroup(ORG, "g1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("group membership", () => {
  beforeEach(() => {
    store.groups = [seedGroup("g1")];
    store.orgMembers = [
      { organizationId: ORG, userId: "u1" },
      { organizationId: ORG, userId: "u2" },
    ];
  });

  it("listOrgGroupMembers 404s an unknown group", async () => {
    await expect(listOrgGroupMembers(ORG, "nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  describe("setOrgGroupMembers", () => {
    it("diffs, validates before writing, and is a no-op when equal", async () => {
      const first = await setOrgGroupMembers(ORG, "actor", "g1", ["u1", "u2"]);
      expect(first).toEqual({ added: 2, removed: 0 });

      const noop = await setOrgGroupMembers(ORG, "actor", "g1", ["u2", "u1"]);
      expect(noop).toEqual({ added: 0, removed: 0 });

      const replace = await setOrgGroupMembers(ORG, "actor", "g1", ["u2"]);
      expect(replace).toEqual({ added: 0, removed: 1 });
      expect(store.groupMembers.map((m) => m.userId)).toEqual(["u2"]);
    });

    it("rejects non-members before any write", async () => {
      await expect(
        setOrgGroupMembers(ORG, "actor", "g1", ["u1", "ghost"]),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Not members of this organization: ghost",
      });
      expect(store.groupMembers).toHaveLength(0);
    });

    it("409s the SCIM lock", async () => {
      store.groups = [seedGroup("g1", { source: "scim" })];
      await expect(
        setOrgGroupMembers(ORG, "actor", "g1", ["u1"]),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("addOrgGroupMember / removeOrgGroupMember", () => {
    it("add is idempotent", async () => {
      await expect(
        addOrgGroupMember(ORG, "actor", "g1", "u1"),
      ).resolves.toEqual({ added: true });
      await expect(
        addOrgGroupMember(ORG, "actor", "g1", "u1"),
      ).resolves.toEqual({ added: false });
    });

    it("add rejects a non-member", async () => {
      await expect(
        addOrgGroupMember(ORG, "actor", "g1", "ghost"),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "User is not a member of this organization",
      });
    });

    it("remove is idempotent", async () => {
      await expect(removeOrgGroupMember(ORG, "g1", "u1")).resolves.toEqual({
        removed: false,
      });
      await addOrgGroupMember(ORG, "actor", "g1", "u1");
      await expect(removeOrgGroupMember(ORG, "g1", "u1")).resolves.toEqual({
        removed: true,
      });
    });
  });
});
