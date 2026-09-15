import { afterEach, describe, expect, it, vi } from "vitest";

// ── Org departure is FREE — and stays free ─────────────────────────────────
//
// Member departure is the deliberate free escape from the otherwise-dark EE
// surface: a member (or a flat-team admin) removing a membership must keep
// working, or self-hosted orgs could never shed members.
//
// Ported from the deleted packages/api/src/licensing/org-departure-free.test.ts
// (the whole licensed/unlicensed entitlement-toggle harness that test lived in
// is retired — see docs/upstream-sync/v2-migration/plan.md, Principle 3:
// there is no more ENTERPRISE_ENABLED and every unlicensed arm collapses to
// the licensed arm). What survives here is the behavior it pinned: leave-org
// succeeds, period, and the owner-block is a domain rule, not a license rule.
//
// Behavioral, with a recording proxy db (the sso-trust style).

vi.hoisted(() => {
  process.env.SECRET_ENCRYPTION_KEY ??= "test-secret";
});

const store = vi.hoisted(() => ({
  role: "member" as string,
  calls: [] as string[],
}));

// A proxy double: every model.method resolves a benign empty, recorded by
// name; targeted overrides below. Departure touches many tables — what
// matters here is that it completes, not row plumbing.
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
          if (method === "findUnique" && name === "organizationMember") {
            return record(`${name}.findUnique`, {
              role: store.role,
              userEmail: "leaver@example.com",
              user: { externalAuthId: "ext-1" },
            });
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
    db: new Proxy({}, { get: (_t, name: string) => model(name) }),
  };
});

import {
  findDeletablePersonalWorkspaces,
  listMembers,
  removeMember,
} from "../ee/services/team-service";

describe("org departure stays free (the deliberate escape)", () => {
  afterEach(() => {
    store.role = "member";
    store.calls = [];
  });

  it("removeMember completes for a voluntary leave", async () => {
    // Voluntary-leave shape: revokeIdentity:false ⇒ "skipped" — the leaver
    // keeps their own login.
    await expect(
      removeMember("org-1", "user-2", { revokeIdentity: false }),
    ).resolves.toBe("skipped");
    // The membership row actually went — departure worked, not just no-op'd.
    expect(store.calls).toContain("organizationMember.delete");
  });

  it("the owner-block is a domain rule, not a license rule", async () => {
    store.role = "owner";
    await expect(removeMember("org-1", "user-2")).rejects.toThrow(
      "The organization owner cannot be removed",
    );
  });

  it("listMembers answers — the flat-team page's only data source", async () => {
    await expect(listMembers("org-1")).resolves.toBeDefined();
  });

  it("findDeletablePersonalWorkspaces answers — the leave dialog's warning", async () => {
    // The dialog that tells a leaver which workspaces vanish with them.
    await expect(
      findDeletablePersonalWorkspaces("org-1", "user-2"),
    ).resolves.toBeDefined();
  });
});
