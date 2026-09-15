import { beforeEach, describe, expect, it, vi } from "vitest";

interface SecretRow {
  id: string;
  name: string;
  type: string;
  organizationId: string | null;
}

interface BudgetRow {
  id: string;
  secretId: string;
  organizationId: string;
  limitCents: number;
  period: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const state = vi.hoisted(() => ({
  secrets: [] as SecretRow[],
  budgets: [] as BudgetRow[],
  spends: [] as {
    secretId: string;
    organizationId: string;
    period: string;
    spentNanos: bigint;
  }[],
  nextId: 1,
}));

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  const withSecret = (b: BudgetRow) => {
    const secret = state.secrets.find((s) => s.id === b.secretId);
    if (!secret) throw new Error("test fixture missing secret");
    return {
      ...b,
      secret: { name: secret.name, type: secret.type },
    };
  };

  return {
    Prisma: { PrismaClientKnownRequestError },
    db: {
      secret: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          state.secrets.find((s) => s.id === where.id) ?? null,
      },
      budget: {
        findMany: async ({ where }: { where: { organizationId: string } }) =>
          state.budgets
            .filter((b) => b.organizationId === where.organizationId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map(withSecret),
        findFirst: async ({
          where,
        }: {
          where: { id: string; organizationId: string };
        }) => {
          const found = state.budgets.find(
            (b) =>
              b.id === where.id && b.organizationId === where.organizationId,
          );
          return found ? withSecret(found) : null;
        },
        create: async ({
          data,
        }: {
          data: Omit<BudgetRow, "id" | "createdAt" | "updatedAt">;
        }) => {
          const dupe = state.budgets.find(
            (b) =>
              b.secretId === data.secretId &&
              b.organizationId === data.organizationId,
          );
          if (dupe) {
            throw new PrismaClientKnownRequestError("duplicate", "P2002");
          }
          const now = new Date();
          const created: BudgetRow = {
            id: `budget-${state.nextId++}`,
            secretId: data.secretId,
            organizationId: data.organizationId,
            limitCents: data.limitCents,
            period: data.period,
            createdBy: data.createdBy,
            createdAt: now,
            updatedAt: now,
          };
          state.budgets.push(created);
          return created;
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Pick<BudgetRow, "limitCents" | "period">>;
        }) => {
          const budget = state.budgets.find((b) => b.id === where.id);
          if (!budget) throw new Error("test fixture missing budget");
          Object.assign(budget, data, { updatedAt: new Date() });
          return withSecret(budget);
        },
        delete: async ({ where }: { where: { id: string } }) => {
          state.budgets = state.budgets.filter((b) => b.id !== where.id);
          return {};
        },
      },
      budgetSpend: {
        findFirst: async ({
          where,
        }: {
          where: { organizationId: string; secretId: string; period: string };
        }) =>
          state.spends.find(
            (s) =>
              s.organizationId === where.organizationId &&
              s.secretId === where.secretId &&
              s.period === where.period,
          ) ?? null,
        findMany: async ({
          where,
        }: {
          where: {
            organizationId: string;
            secretId: { in: string[] };
            period: { in: string[] };
          };
        }) =>
          state.spends.filter(
            (s) =>
              s.organizationId === where.organizationId &&
              where.secretId.in.includes(s.secretId) &&
              where.period.in.includes(s.period),
          ),
      },
    },
  };
});

const { listBudgets, createBudget, updateBudget, deleteBudget } =
  await import("./budget-service");

const ORG = "org-1";
const OTHER_ORG = "org-2";

beforeEach(() => {
  state.secrets = [
    {
      id: "sec-anthropic",
      name: "Anthropic key",
      type: "anthropic",
      organizationId: ORG,
    },
    {
      id: "sec-openai",
      name: "OpenAI key",
      type: "openai",
      organizationId: ORG,
    },
    {
      id: "sec-generic",
      name: "Generic secret",
      type: "generic",
      organizationId: ORG,
    },
    {
      id: "sec-other-org",
      name: "Other org's key",
      type: "anthropic",
      organizationId: OTHER_ORG,
    },
  ];
  state.budgets = [];
  state.spends = [];
  state.nextId = 1;
});

describe("createBudget", () => {
  it("creates a budget on an org-owned anthropic secret", async () => {
    const row = await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "monthly" },
      "user-1",
    );
    expect(row.secretId).toBe("sec-anthropic");
    expect(row.secretType).toBe("anthropic");
    expect(row.limitCents).toBe(5000);
    expect(row.spentCents).toBe(0);
  });

  it("accepts openai too — stored even though the gateway doesn't meter it yet", async () => {
    const row = await createBudget(
      ORG,
      { secretId: "sec-openai", limitCents: 1000, period: "total" },
      "user-1",
    );
    expect(row.secretType).toBe("openai");
  });

  it("404s a secret that doesn't exist", async () => {
    await expect(
      createBudget(
        ORG,
        { secretId: "nope", limitCents: 100, period: "monthly" },
        "u",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("404s a secret owned by a different org (org fence)", async () => {
    await expect(
      createBudget(
        ORG,
        { secretId: "sec-other-org", limitCents: 100, period: "monthly" },
        "u",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("400s a non-metered secret type", async () => {
    await expect(
      createBudget(
        ORG,
        { secretId: "sec-generic", limitCents: 100, period: "monthly" },
        "u",
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Budgets aren't supported for generic secrets yet.",
    });
  });

  it("409s a duplicate (secretId, organizationId)", async () => {
    await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 100, period: "monthly" },
      "u",
    );
    await expect(
      createBudget(
        ORG,
        { secretId: "sec-anthropic", limitCents: 200, period: "monthly" },
        "u",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("listBudgets", () => {
  it("returns [] when the org has no budgets", async () => {
    expect(await listBudgets(ORG)).toEqual([]);
  });

  it("joins current-period spend from budget_spends, keyed off the rendered org:<id> subject", async () => {
    const created = await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "monthly" },
      "u",
    );
    const now = new Date();
    const monthly = `m:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    state.spends.push({
      secretId: "sec-anthropic",
      organizationId: `org:${ORG}`,
      period: monthly,
      spentNanos: 24_999_999n, // 2.4999999 cents worth of nanos -> floors to 2 cents
    });

    const rows = await listBudgets(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.id);
    expect(rows[0]?.spentCents).toBe(2);
  });

  it("reads the 'total' window for a total-period budget", async () => {
    await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "total" },
      "u",
    );
    state.spends.push({
      secretId: "sec-anthropic",
      organizationId: `org:${ORG}`,
      period: "total",
      spentNanos: 10_000_000n, // exactly 1 cent
    });

    const rows = await listBudgets(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentCents).toBe(1);
  });

  it("does not leak another org's spend row for the same secret id", async () => {
    await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "total" },
      "u",
    );
    state.spends.push({
      secretId: "sec-anthropic",
      organizationId: `org:${OTHER_ORG}`,
      period: "total",
      spentNanos: 999_000_000n,
    });

    const rows = await listBudgets(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentCents).toBe(0);
  });
});

describe("updateBudget", () => {
  it("updates limitCents and/or period, org-fenced", async () => {
    const created = await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "monthly" },
      "u",
    );
    const updated = await updateBudget(ORG, created.id, { limitCents: 9000 });
    expect(updated.limitCents).toBe(9000);
    expect(updated.period).toBe("monthly");
  });

  it("404s a budget id from another org", async () => {
    const created = await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "monthly" },
      "u",
    );
    await expect(
      updateBudget(OTHER_ORG, created.id, { limitCents: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("404s an unknown budget id", async () => {
    await expect(
      updateBudget(ORG, "does-not-exist", { limitCents: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deleteBudget", () => {
  it("deletes a budget, org-fenced, and returns its id + secretId", async () => {
    const created = await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "monthly" },
      "u",
    );
    const result = await deleteBudget(ORG, created.id);
    expect(result).toEqual({ id: created.id, secretId: "sec-anthropic" });
    expect(await listBudgets(ORG)).toEqual([]);
  });

  it("404s a budget id from another org", async () => {
    const created = await createBudget(
      ORG,
      { secretId: "sec-anthropic", limitCents: 5000, period: "monthly" },
      "u",
    );
    await expect(deleteBudget(OTHER_ORG, created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
