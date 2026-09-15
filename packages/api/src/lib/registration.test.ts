import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertRegistrationAllowed,
  assertUpgradeWindowClear,
  registrationState,
  SIGNUP_BLOCKED_BY_UPGRADE,
  SIGNUP_REQUIRES_INVITATION,
} from "./registration";
import {
  LEGACY_LOCAL_AUTH_ID,
  LEGACY_LOCAL_EMAIL,
} from "./legacy-local-identity";

// Account creation is governed by `REGISTRATION_MODE` (`./env`): "open"
// admits anyone, "invite" (default) requires a pending invitation or that
// the instance has no real users yet. What remains to prove here is
// smaller and sharper: the screens learn the right moment to stop
// funnelling everyone to the signup form, the upgrade window (checked
// first, unconditionally) fires exactly when adoption would otherwise be
// stranded, and the invite gate admits/refuses exactly per that policy.

type Row = { id: string; email: string; externalAuthId: string };
type Invitation = { email: string; status: string; expiresAt: Date };

const state = {
  users: [] as Row[],
  accountsByUser: {} as Record<string, number>,
  invitations: [] as Invitation[],
};

const prisma = {
  user: {
    findMany: async ({ take }: { take: number }) => state.users.slice(0, take),
    findUnique: async ({ where }: { where: { externalAuthId?: string } }) =>
      state.users.find((u) => u.externalAuthId === where.externalAuthId) ??
      null,
    count: async ({ where }: { where?: { id?: { not: string } } } = {}) =>
      state.users.filter((u) => u.id !== where?.id?.not).length,
  },
  account: {
    count: async ({ where }: { where: { userId: string } }) =>
      state.accountsByUser[where.userId] ?? 0,
  },
  invitation: {
    findFirst: async ({
      where,
    }: {
      where: {
        email: { equals: string; mode: "insensitive" };
        status: string;
        expiresAt: { gt: Date };
      };
    }) => {
      const match = state.invitations.find(
        (i) =>
          i.email.toLowerCase() === where.email.equals.toLowerCase() &&
          i.status === where.status &&
          i.expiresAt > where.expiresAt.gt,
      );
      return match ? { id: "inv-1" } : null;
    },
  },
} as unknown as Parameters<typeof registrationState>[0];

const legacyGhost: Row = {
  id: "legacy-1",
  email: LEGACY_LOCAL_EMAIL,
  externalAuthId: LEGACY_LOCAL_AUTH_ID,
};

const realUser = (n: number): Row => ({
  id: `user-${n}`,
  email: `person${n}@example.test`,
  externalAuthId: `ba:${n}`,
});

beforeEach(() => {
  state.users = [];
  state.accountsByUser = {};
  state.invitations = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("registrationState", () => {
  it("awaits the first account on a fresh install, adopting nothing", async () => {
    await expect(registrationState(prisma)).resolves.toEqual({
      firstAccount: true,
      adoptsExistingInstall: false,
    });
  });

  it("awaits the first account beside the pre-2.0 placeholder, and says it adopts", async () => {
    state.users = [legacyGhost];

    // The operator has been running this instance without a login. Registering
    // takes it over rather than starting a second, empty one.
    await expect(registrationState(prisma)).resolves.toEqual({
      firstAccount: true,
      adoptsExistingInstall: true,
    });
  });

  it("is established once the instance has one real account", async () => {
    state.users = [realUser(1)];
    await expect(registrationState(prisma)).resolves.toEqual({
      firstAccount: false,
      adoptsExistingInstall: false,
    });
  });

  it("is established with two or more accounts", async () => {
    state.users = [legacyGhost, realUser(1)];
    await expect(registrationState(prisma)).resolves.toMatchObject({
      firstAccount: false,
    });
  });

  it("is established when the lone legacy row has a credential behind it", async () => {
    // Somebody signed in as this row at some point, which makes it a real
    // account rather than the placeholder — nothing left to adopt.
    state.users = [legacyGhost];
    state.accountsByUser[legacyGhost.id] = 1;

    await expect(registrationState(prisma)).resolves.toMatchObject({
      firstAccount: false,
    });
  });

  it("is established for a lone row that only LOOKS legacy", async () => {
    // Both halves of the identity are required. A user who happens to hold the
    // legacy email, or the legacy identity under a different address, is not
    // the row the upgrade path created.
    state.users = [{ ...legacyGhost, externalAuthId: "ba:someone" }];
    await expect(registrationState(prisma)).resolves.toMatchObject({
      firstAccount: false,
    });

    state.users = [{ ...legacyGhost, email: "someone@example.test" }];
    await expect(registrationState(prisma)).resolves.toMatchObject({
      firstAccount: false,
    });
  });

  it("only ever reads two rows, however large the table is", async () => {
    const findMany = vi.fn(async () => [realUser(1), realUser(2)]);
    const counting = {
      user: { findMany },
      account: { count: async () => 0 },
    } as unknown as Parameters<typeof registrationState>[0];

    await registrationState(counting);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });
});

describe("assertUpgradeWindowClear", () => {
  it("admits everyone on a fresh install", async () => {
    await expect(assertUpgradeWindowClear(prisma)).resolves.toBeUndefined();
  });

  it("admits everyone on an established multi-user instance", async () => {
    state.users = [realUser(1), realUser(2), realUser(3)];
    await expect(assertUpgradeWindowClear(prisma)).resolves.toBeUndefined();
  });

  it("admits the claimer while the placeholder is still alone", async () => {
    // The account the adoption is waiting for has to be able to register.
    state.users = [legacyGhost];
    await expect(assertUpgradeWindowClear(prisma)).resolves.toBeUndefined();
  });

  it("refuses a second registrant while the claimer has not signed in yet", async () => {
    // Adoption requires exactly the placeholder and the claimer; letting a
    // third row in here would strand the old install's data forever. The
    // code matters: the identity layer's own "could not create user" is
    // indistinguishable from the database being down.
    state.users = [legacyGhost, realUser(1)];

    await expect(assertUpgradeWindowClear(prisma)).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: SIGNUP_BLOCKED_BY_UPGRADE },
    });
  });

  it("keeps refusing in the stuck state, where two claimers raced in", async () => {
    state.users = [legacyGhost, realUser(1), realUser(2)];

    await expect(assertUpgradeWindowClear(prisma)).rejects.toMatchObject({
      body: { code: SIGNUP_BLOCKED_BY_UPGRADE },
    });
  });

  it("refuses with a message that survives URL encoding", async () => {
    // A refused social sign-up comes back as a redirect whose ?error= is the
    // message with spaces turned into underscores. A sentence would arrive
    // mangled and unmatchable; the token arrives intact.
    state.users = [legacyGhost, realUser(1)];

    await expect(assertUpgradeWindowClear(prisma)).rejects.toMatchObject({
      message: SIGNUP_BLOCKED_BY_UPGRADE,
    });
    expect(SIGNUP_BLOCKED_BY_UPGRADE).not.toContain(" ");
  });

  it("stands down once the placeholder has a credential — that is a person", async () => {
    // A credentialed "legacy" row is somebody's real account; refusing new
    // registrations to protect it would protect nothing.
    state.users = [legacyGhost, realUser(1)];
    state.accountsByUser[legacyGhost.id] = 1;

    await expect(assertUpgradeWindowClear(prisma)).resolves.toBeUndefined();
  });

  it("stands down for a row that only LOOKS legacy", async () => {
    state.users = [
      { ...legacyGhost, email: "someone@example.test" },
      realUser(1),
    ];
    await expect(assertUpgradeWindowClear(prisma)).resolves.toBeUndefined();
  });

  it("orders the upgrade-window refusal before the invite gate", async () => {
    // Both conditions that refuse are true at once: an unclaimed upgrade
    // window (legacyGhost + one unfinished claimer) AND no invitation for
    // the newcomer's email. `better-auth.ts`'s creation hook calls these two
    // guards in exactly this sequence — the upgrade window must win, since
    // it protects data an upgrading operator already has and its refusal
    // must never be masked by the invite gate's.
    state.users = [legacyGhost, realUser(1)];

    const runHookOrder = async (email: string) => {
      await assertUpgradeWindowClear(prisma);
      await assertRegistrationAllowed(email, prisma);
    };

    await expect(runHookOrder("stranger@example.test")).rejects.toMatchObject({
      body: { code: SIGNUP_BLOCKED_BY_UPGRADE },
    });
  });
});

describe("assertRegistrationAllowed", () => {
  it("in open mode, admits anyone regardless of established users or invitations", async () => {
    vi.stubEnv("ONECLI_REGISTRATION", "open");
    vi.resetModules();
    const openModule = await import("./registration");

    state.users = [realUser(1), realUser(2)];
    state.invitations = [];

    await expect(
      openModule.assertRegistrationAllowed("stranger@example.test", prisma),
    ).resolves.toBeUndefined();
  });

  it("in invite mode, admits the first account regardless of any invitation", async () => {
    // No users yet: a fresh install. The bootstrap exception must not
    // require an invitation.
    state.users = [];
    state.invitations = [];

    await expect(
      assertRegistrationAllowed("first-admin@example.test", prisma),
    ).resolves.toBeUndefined();
  });

  it("in invite mode, admits an established instance's pending, unexpired, exact-case invitation", async () => {
    state.users = [realUser(1)];
    state.invitations = [
      {
        email: "invited@example.test",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];

    await expect(
      assertRegistrationAllowed("invited@example.test", prisma),
    ).resolves.toBeUndefined();
  });

  it("in invite mode, matches the invitation's email case-insensitively", async () => {
    state.users = [realUser(1)];
    state.invitations = [
      {
        email: "Invited@Example.test",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];

    await expect(
      assertRegistrationAllowed("invited@example.test", prisma),
    ).resolves.toBeUndefined();
  });

  it("in invite mode, refuses an established instance's expired invitation", async () => {
    state.users = [realUser(1)];
    state.invitations = [
      {
        email: "invited@example.test",
        status: "pending",
        expiresAt: new Date(Date.now() - 60_000),
      },
    ];

    await expect(
      assertRegistrationAllowed("invited@example.test", prisma),
    ).rejects.toMatchObject({
      body: { code: SIGNUP_REQUIRES_INVITATION },
    });
  });

  it("in invite mode, refuses an established instance with no invitation at all", async () => {
    state.users = [realUser(1)];
    state.invitations = [];

    await expect(
      assertRegistrationAllowed("stranger@example.test", prisma),
    ).rejects.toMatchObject({
      body: { code: SIGNUP_REQUIRES_INVITATION },
    });
  });

  it("in invite mode, a pending invitation for a DIFFERENT email does not admit the signup", async () => {
    // Google (or password) sign-up is keyed on the email being created, never
    // on which invite token (if any) was in the URL. An invitation that
    // exists for somebody else's address must not leak an allow to this one.
    state.users = [realUser(1)];
    state.invitations = [
      {
        email: "someone-else@example.test",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];

    await expect(
      assertRegistrationAllowed("stranger@example.test", prisma),
    ).rejects.toMatchObject({
      body: { code: SIGNUP_REQUIRES_INVITATION },
    });
  });
});
