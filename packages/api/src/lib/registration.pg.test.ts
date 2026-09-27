import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

// Self-hosted only, and the code under test reaches Prisma at module load —
// see the sibling adoption proof for why both pins have to be hoisted.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  const proofUrl = process.env.POLICY_PROOF_DATABASE_URL;
  if (proofUrl) process.env.DATABASE_URL = proofUrl;
});

import { randomUUID } from "node:crypto";
import { db } from "@onecli/db";
import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { withoutLegacyLocalRow } from "../testing/scoped-prisma";
import { createInvitation } from "../services/invitation-service";
import { createOnpremAuth } from "./better-auth";
import { SIGNUP_REQUIRES_INVITATION } from "./registration";

/**
 * That the `ONECLI_REGISTRATION` policy is actually WIRED IN.
 *
 * The policy itself is unit-tested. What no unit test can show is what the
 * identity layer does with it: sign-up runs through a database hook the
 * library calls, and a regression there — a refusal creeping back in wrong,
 * or the hook displacing the identity stamp — would leave every unit test
 * green while real deployments behaved differently. So this drives the real
 * library, over real rows, with the configuration production ships.
 *
 * The instance is seeded with existing accounts first: invite mode's refusal
 * only bites once the deployment is established (`registrationState()`'s
 * `firstAccount` exception is proven in the unit suite).
 *
 * The one refusal that still outranks this policy — the pre-2.0 upgrade
 * window — has its own wiring proof beside the adoption suite, which owns
 * the placeholder-row fixture. Here the placeholder lookup is scoped out
 * (`withoutLegacyLocalRow`) so that suite's fixture cannot flake this one on
 * the shared proof database.
 */

const PROOF_URL = proofDatabaseUrl();

const SECRET = "pg-proof-registration-secret-pg-proof-registration";
const BASE_URL = "http://127.0.0.1:10257";
const FIRST_EMAIL = `first-${randomUUID()}@example.invalid`;
const SECOND_EMAIL = `second-${randomUUID()}@example.invalid`;
const OWNER_EMAIL = `inviter-${randomUUID()}@example.invalid`;
const UNINVITED_EMAIL = `uninvited-${randomUUID()}@example.invalid`;
const OPEN_MODE_EMAIL = `open-mode-${randomUUID()}@example.invalid`;
const INVITED_EMAIL = `invited-${randomUUID()}@example.invalid`;
// Same LENGTH local part as INVITED_EMAIL, replaced entirely with `_` — a
// legal email character that is ALSO Postgres ILIKE's single-character
// wildcard. If the invite gate ever regresses to deciding on the raw
// `mode: "insensitive"` match instead of a strict post-check, this
// ILIKE-matches INVITED_EMAIL's pending invitation and gets an account it
// was never invited to.
const WILDCARD_INVITED_EMAIL = `${"_".repeat(INVITED_EMAIL.indexOf("@"))}${INVITED_EMAIL.slice(INVITED_EMAIL.indexOf("@"))}`;
const PASSWORD = "correct horse battery staple";

const seeded: string[] = [];
let organizationId: string | null = null;

const seedUser = async (email: string) => {
  const user = await db.user.create({
    data: { email, externalAuthId: `ba:${randomUUID()}` },
  });
  seeded.push(user.id);
  return user;
};

describe.skipIf(!PROOF_URL)(
  "registration mode wiring over real PostgreSQL",
  () => {
    beforeAll(async () => {
      // The established-instance state invite mode gates: an instance that
      // already has real accounts.
      await seedUser(FIRST_EMAIL);
      await seedUser(SECOND_EMAIL);

      // A real, pending, FK-backed invitation — the invite-mode allow path
      // needs a genuine row, not a mocked `invitation.findFirst`.
      const owner = await seedUser(OWNER_EMAIL);
      const org = await db.organization.create({
        data: {
          name: "Registration Proof Org",
          slug: `registration-proof-${owner.id.slice(0, 8)}`,
          members: {
            create: {
              userId: owner.id,
              userEmail: OWNER_EMAIL,
              role: "owner",
            },
          },
        },
      });
      organizationId = org.id;
      await createInvitation({
        organizationId: org.id,
        email: INVITED_EMAIL,
        role: "member",
        invitedById: owner.id,
        invitedByEmail: OWNER_EMAIL,
      });
    });

    afterAll(async () => {
      const emails = [
        FIRST_EMAIL,
        SECOND_EMAIL,
        OWNER_EMAIL,
        UNINVITED_EMAIL,
        OPEN_MODE_EMAIL,
        INVITED_EMAIL,
        WILDCARD_INVITED_EMAIL,
      ];
      const users = await db.user.findMany({
        where: { email: { in: emails } },
        select: { id: true },
      });
      const ids = [...new Set([...seeded, ...users.map((u) => u.id)])];

      if (organizationId) {
        await db.invitation.deleteMany({ where: { organizationId } });
        await db.organizationMember.deleteMany({ where: { organizationId } });
      }
      await db.session.deleteMany({ where: { userId: { in: ids } } });
      await db.account.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      if (organizationId) {
        await db.organization
          .delete({ where: { id: organizationId } })
          .catch(() => {});
      }
    });

    it("(default: invite) refuses an uninvited newcomer on an established instance, and creates nothing", async () => {
      const auth = createOnpremAuth({
        secret: SECRET,
        baseURL: BASE_URL,
        prisma: withoutLegacyLocalRow(db),
      });

      const response = await auth.api.signUpEmail({
        body: {
          email: UNINVITED_EMAIL,
          password: PASSWORD,
          name: "Uninvited",
        },
        asResponse: true,
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: SIGNUP_REQUIRES_INVITATION,
      });
      expect(
        await db.user.findUnique({ where: { email: UNINVITED_EMAIL } }),
      ).toBeNull();
    });

    it("(default: invite) an underscore-wildcard email the same length as a real invitation is still refused, and creates nothing", async () => {
      // Regression for the ILIKE-wildcard bug: `mode: "insensitive"` compiles
      // to Postgres `ILIKE`, and `_` matches any single character. Signing up
      // as WILDCARD_INVITED_EMAIL must NOT be treated as holding
      // INVITED_EMAIL's pending invitation just because it ILIKE-matches it.
      const auth = createOnpremAuth({
        secret: SECRET,
        baseURL: BASE_URL,
        prisma: withoutLegacyLocalRow(db),
      });

      const response = await auth.api.signUpEmail({
        body: {
          email: WILDCARD_INVITED_EMAIL,
          password: PASSWORD,
          name: "Wildcard",
        },
        asResponse: true,
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: SIGNUP_REQUIRES_INVITATION,
      });
      expect(
        await db.user.findUnique({ where: { email: WILDCARD_INVITED_EMAIL } }),
      ).toBeNull();
    });

    it("(ONECLI_REGISTRATION=open) accepts a sign-up on an instance that already has accounts", async () => {
      vi.stubEnv("ONECLI_REGISTRATION", "open");
      vi.resetModules();
      try {
        const { createOnpremAuth: createOpenModeAuth } =
          await import("./better-auth");

        const auth = createOpenModeAuth({
          secret: SECRET,
          baseURL: BASE_URL,
          prisma: withoutLegacyLocalRow(db),
        });

        const response = await auth.api.signUpEmail({
          body: {
            email: OPEN_MODE_EMAIL,
            password: PASSWORD,
            name: "Newcomer",
          },
          asResponse: true,
        });

        expect(response.status).toBe(200);

        const created = await db.user.findUniqueOrThrow({
          where: { email: OPEN_MODE_EMAIL },
        });
        // The identity every other service resolves users by is stamped in
        // the same creation hook — sign-up succeeding is not enough, the
        // account has to be resolvable by the API middleware and the
        // gateway.
        expect(created.externalAuthId).toMatch(/^ba:/);
      } finally {
        // In a `finally`, not the happy path's tail: a failed assertion above
        // must not leave ONECLI_REGISTRATION=open stubbed for every test that
        // runs after this one in the same worker.
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });

    it("(default: invite) accepts a sign-up for an email holding a real, pending invitation", async () => {
      const auth = createOnpremAuth({
        secret: SECRET,
        baseURL: BASE_URL,
        prisma: withoutLegacyLocalRow(db),
      });

      const response = await auth.api.signUpEmail({
        body: { email: INVITED_EMAIL, password: PASSWORD, name: "Invited" },
        asResponse: true,
      });

      expect(response.status).toBe(200);

      const created = await db.user.findUniqueOrThrow({
        where: { email: INVITED_EMAIL },
      });
      expect(created.externalAuthId).toMatch(/^ba:/);
    });
  },
);
