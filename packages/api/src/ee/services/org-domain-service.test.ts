import { beforeEach, describe, expect, it, vi } from "vitest";

// The org's claimed email domains (api-ee-behaviour §8.1): normalization
// (incl. punycode), the public-mailbox blocklist, global uniqueness, and the
// DNS TXT verify flow with `node:dns/promises` mocked.

interface DomainRecord {
  id: string;
  organizationId: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  domains: [] as DomainRecord[],
}));

const dns = vi.hoisted(() => ({
  resolveTxt: vi.fn<(domain: string) => Promise<string[][]>>(),
}));
vi.mock("node:dns/promises", () => ({ resolveTxt: dns.resolveTxt }));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    organizationDomain: {
      count: async ({ where }: { where: { organizationId: string } }) =>
        store.domains.filter((d) => d.organizationId === where.organizationId)
          .length,
      findMany: async ({ where }: { where: { organizationId: string } }) =>
        store.domains
          .filter((d) => d.organizationId === where.organizationId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) =>
        store.domains.find(
          (d) => d.id === where.id && d.organizationId === where.organizationId,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: Omit<DomainRecord, "id" | "verifiedAt" | "createdAt">;
      }) => {
        if (store.domains.some((d) => d.domain === data.domain)) {
          throw { code: "P2002" };
        }
        const row: DomainRecord = {
          id: `dom-${store.domains.length + 1}`,
          verifiedAt: null,
          createdAt: new Date("2026-01-01"),
          ...data,
        };
        store.domains.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; organizationId: string };
        data: Partial<DomainRecord>;
      }) => {
        const row = store.domains.find(
          (d) => d.id === where.id && d.organizationId === where.organizationId,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) => {
        const before = store.domains.length;
        store.domains = store.domains.filter(
          (d) =>
            !(d.id === where.id && d.organizationId === where.organizationId),
        );
        return { count: before - store.domains.length };
      },
    },
  },
}));

import {
  claimOrgDomain,
  deleteOrgDomain,
  emailDomainOf,
  listOrgDomains,
  verifyOrgDomain,
} from "./org-domain-service";

const ORG = "org-1";

beforeEach(() => {
  store.domains = [];
  dns.resolveTxt.mockReset();
});

describe("claimOrgDomain — normalization", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["example.com.", "example.com"],
    ["  example.com  ", "example.com"],
    ["münchen.de", "xn--mnchen-3ya.de"],
  ])("normalizes %s to %s", async (raw, expected) => {
    const row = await claimOrgDomain(ORG, "user-1", raw);
    expect(row.domain).toBe(expected);
  });

  it.each([
    ["not a domain", "shape"],
    ["nodot", "no dot"],
    ["a..b.com", "empty label"],
    ["http://example.com", "a URL"],
    ["user@example.com", "an email address"],
    ["192.168.0.1", "an IP literal"],
  ])("rejects %s (%s) with the shape message", async (raw) => {
    await expect(claimOrgDomain(ORG, "user-1", raw)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Enter a valid domain like example.com",
    });
  });

  it("refuses public mailbox providers", async () => {
    await expect(
      claimOrgDomain(ORG, "user-1", "gmail.com"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Public email providers can't be claimed. Use your company's domain.",
    });
  });

  it("generates a 32-hex-char (16-byte) verification token", async () => {
    const row = await claimOrgDomain(ORG, "user-1", "example.com");
    expect(row.verificationToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("409s a globally-duplicate domain, even across orgs", async () => {
    await claimOrgDomain(ORG, "user-1", "example.com");
    await expect(
      claimOrgDomain("org-2", "user-2", "example.com"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This domain is already claimed by an organization.",
    });
  });
});

describe("listOrgDomains", () => {
  it("lists only this org's domains, oldest first", async () => {
    await claimOrgDomain(ORG, "u1", "a.com");
    await claimOrgDomain(ORG, "u1", "b.com");
    await claimOrgDomain("org-2", "u2", "c.com");
    const rows = await listOrgDomains(ORG);
    expect(rows.map((r) => r.domain)).toEqual(["a.com", "b.com"]);
  });
});

describe("verifyOrgDomain", () => {
  it("verifies when the TXT record matches exactly, chunk-joined and case-folded", async () => {
    const claimed = await claimOrgDomain(ORG, "u1", "example.com");
    dns.resolveTxt.mockResolvedValue([
      [`ONECLI-VERIFICATION=`, claimed.verificationToken.toUpperCase()],
    ]);
    const result = await verifyOrgDomain(ORG, claimed.id);
    expect(result.domain.verifiedAt).not.toBeNull();
    expect(result.changed).toBe(true);
    expect(dns.resolveTxt).toHaveBeenCalledWith("example.com");
  });

  it("is idempotent on an already-verified row — no DNS call, changed: false", async () => {
    const claimed = await claimOrgDomain(ORG, "u1", "example.com");
    dns.resolveTxt.mockResolvedValue([
      [`onecli-verification=${claimed.verificationToken}`],
    ]);
    await verifyOrgDomain(ORG, claimed.id);
    dns.resolveTxt.mockClear();
    const again = await verifyOrgDomain(ORG, claimed.id);
    expect(again.domain.verifiedAt).not.toBeNull();
    expect(again.changed).toBe(false);
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it.each(["ENOTFOUND", "ENODATA", "SERVFAIL"])(
    "%s maps to the 'not found yet' message",
    async (code) => {
      const claimed = await claimOrgDomain(ORG, "u1", "example.com");
      dns.resolveTxt.mockRejectedValue(
        Object.assign(new Error("dns"), { code }),
      );
      await expect(verifyOrgDomain(ORG, claimed.id)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message:
          "TXT record not found yet. DNS changes can take a few minutes to propagate.",
      });
    },
  );

  it.each(["ETIMEOUT", "ECONNREFUSED", "EREFUSED"])(
    "%s (the lookup itself failed) maps to a retryable 400, not a 500",
    async (code) => {
      const claimed = await claimOrgDomain(ORG, "u1", "example.com");
      dns.resolveTxt.mockRejectedValue(
        Object.assign(new Error("dns"), { code }),
      );
      await expect(verifyOrgDomain(ORG, claimed.id)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "DNS lookup failed, try again.",
      });
    },
  );

  it("a mismatched record also reads as 'not found yet'", async () => {
    const claimed = await claimOrgDomain(ORG, "u1", "example.com");
    dns.resolveTxt.mockResolvedValue([["onecli-verification=wrong-token"]]);
    await expect(verifyOrgDomain(ORG, claimed.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("a genuinely unrecognised DNS error propagates rather than being swallowed", async () => {
    const claimed = await claimOrgDomain(ORG, "u1", "example.com");
    dns.resolveTxt.mockRejectedValue(
      Object.assign(new Error("boom"), { code: "EWEIRD" }),
    );
    await expect(verifyOrgDomain(ORG, claimed.id)).rejects.toThrow("boom");
  });

  it("404s a cross-org domain id", async () => {
    const claimed = await claimOrgDomain(ORG, "u1", "example.com");
    await expect(verifyOrgDomain("org-2", claimed.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("claimOrgDomain — per-org cap", () => {
  it("refuses a 26th domain", async () => {
    for (let i = 0; i < 25; i++) {
      await claimOrgDomain(ORG, "u1", `d${i}.example.com`);
    }
    await expect(
      claimOrgDomain(ORG, "u1", "one-too-many.example.com"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "An organization can hold at most 25 domains. Remove one before adding another.",
    });
  });

  it("does not count another org's domains toward the cap", async () => {
    for (let i = 0; i < 25; i++) {
      await claimOrgDomain("org-2", "u1", `other${i}.example.com`);
    }
    await expect(
      claimOrgDomain(ORG, "u1", "fine.example.com"),
    ).resolves.toMatchObject({ domain: "fine.example.com" });
  });
});

describe("deleteOrgDomain", () => {
  it("deletes within the org fence", async () => {
    const claimed = await claimOrgDomain(ORG, "u1", "example.com");
    await deleteOrgDomain(ORG, claimed.id);
    await expect(listOrgDomains(ORG)).resolves.toEqual([]);
  });

  it("404s when nothing matched (wrong org or id)", async () => {
    const claimed = await claimOrgDomain(ORG, "u1", "example.com");
    await expect(deleteOrgDomain("org-2", claimed.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("emailDomainOf", () => {
  it("applies the same normalization to the part after the last @", () => {
    expect(emailDomainOf("Person@Example.COM")).toBe("example.com");
    expect(emailDomainOf("nope")).toBeNull();
    expect(emailDomainOf("trailing@")).toBeNull();
  });
});
