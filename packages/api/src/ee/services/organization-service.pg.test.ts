import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * `deleteOrganization`'s hand-written cascade on REAL PostgreSQL
 * (api-ee-behaviour risk 4 / phase2-plan.md WP-A): the four identity tables
 * WP-A added to `deleteOrganizationContent` — `organization_domains`,
 * `organization_sso_connections`, `organization_scim_tokens`,
 * `app_availability_rules` — are `onDelete: RESTRICT` on their organization
 * FK, not `CASCADE`. Trusting the schema comment is exactly the mistake this
 * suite exists to catch: it first proves the FK really is Restrict (a bare
 * `organization.delete()` with a surviving child row must fail), then proves
 * the real service tears every one of them down before the org row goes.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type OrgService = typeof import("./organization-service");

let db: Db;
let svc: OrgService;

const P = "wpa-orgdel-";
const OWNER = `${P}owner`;
const OWNER_EMAIL = `${OWNER}@example.invalid`;

const freshOrgId = () => `${P}org-${Math.random().toString(36).slice(2, 10)}`;

const reset = async () => {
  const orgs = await db.organization.findMany({
    where: { id: { startsWith: P } },
    select: { id: true },
  });
  const orgIds = orgs.map((o) => o.id);
  if (orgIds.length > 0) {
    await db.appAvailabilityRule.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organizationDomain.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organizationSsoConnection.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organizationScimToken.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.workspace.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organizationMember.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
  await db.user.deleteMany({ where: { id: OWNER } });
};

describe.skipIf(!PROOF_URL)(
  "deleteOrganization's identity-table cascade on real PostgreSQL",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = PROOF_URL;
      process.env.EDITION = "onprem";
      process.env.NEXT_PUBLIC_EDITION = "onprem";
      ({ db } = await import("@onecli/db"));
      svc = await import("./organization-service");
      await reset();
      await db.user.create({
        data: {
          id: OWNER,
          email: OWNER_EMAIL,
          externalAuthId: `${P}auth-owner`,
        },
      });
    });

    afterEach(async () => {
      await reset();
      // `reset` also removes the shared owner user; every test re-seeds it,
      // and the org rows it creates are test-local, so restore it here too.
      await db.user.upsert({
        where: { id: OWNER },
        create: {
          id: OWNER,
          email: OWNER_EMAIL,
          externalAuthId: `${P}auth-owner`,
        },
        update: {},
      });
    });

    afterAll(async () => {
      await reset();
      await db.$disconnect();
    });

    const seedOrgWithOwner = async (orgId: string) => {
      await db.organization.create({
        data: {
          id: orgId,
          name: "WP-A org-delete proof",
          slug: orgId,
          members: {
            create: { userId: OWNER, userEmail: OWNER_EMAIL, role: "owner" },
          },
          workspaces: {
            create: {
              id: `${orgId}-ws`,
              name: "Default",
              slug: "default",
              createdByUserId: OWNER,
              createdByUserEmail: OWNER_EMAIL,
            },
          },
        },
      });
    };

    it.each([
      [
        "organization_domains",
        (orgId: string) =>
          db.organizationDomain.create({
            data: {
              organizationId: orgId,
              domain: `${orgId.replace(/[^a-z0-9]/g, "")}.example`,
              verificationToken: "a".repeat(32),
            },
          }),
      ],
      [
        "organization_sso_connections",
        (orgId: string) =>
          db.organizationSsoConnection.create({
            data: {
              organizationId: orgId,
              type: "oidc",
              cognitoProviderName: `${orgId}-provider`,
              displayName: "Proof IdP",
            },
          }),
      ],
      [
        "organization_scim_tokens",
        (orgId: string) =>
          db.organizationScimToken.create({
            data: {
              organizationId: orgId,
              tokenHash: `${orgId}-hash`,
              label: "Proof token",
            },
          }),
      ],
      [
        "app_availability_rules",
        (orgId: string) =>
          db.appAvailabilityRule.create({
            data: { organizationId: orgId, name: "Proof rule" },
          }),
      ],
    ] as const)(
      "%s is onDelete: RESTRICT — a bare organization.delete() fails while a row survives",
      async (_table, seedChild) => {
        const orgId = freshOrgId();
        await seedOrgWithOwner(orgId);
        await seedChild(orgId);
        // The child row alone should block the org delete — no cascade helper
        // involved, proving the FK itself (not application code) enforces it.
        // Postgres reports a RESTRICT violation as SQLSTATE 23001, which
        // Prisma surfaces as an unwrapped `PrismaClientUnknownRequestError`
        // (not its usual P2003 for a plain 23503 foreign-key violation) — so
        // this asserts on the underlying Postgres message, the actual proof.
        await db.workspace.deleteMany({ where: { organizationId: orgId } });
        await db.organizationMember.deleteMany({
          where: { organizationId: orgId },
        });
        await expect(
          db.organization.delete({ where: { id: orgId } }),
        ).rejects.toThrow(
          /violates RESTRICT setting of foreign key constraint/,
        );
      },
    );

    it("deleteOrganization tears down every identity table before the org row, real FKs included", async () => {
      const orgId = freshOrgId();
      await seedOrgWithOwner(orgId);
      await db.organizationDomain.create({
        data: {
          organizationId: orgId,
          domain: `${orgId.replace(/[^a-z0-9]/g, "")}.example`,
          verificationToken: "b".repeat(32),
        },
      });
      await db.organizationSsoConnection.create({
        data: {
          organizationId: orgId,
          type: "oidc",
          cognitoProviderName: `${orgId}-provider`,
          displayName: "Proof IdP",
        },
      });
      await db.organizationScimToken.create({
        data: {
          organizationId: orgId,
          tokenHash: `${orgId}-hash`,
          label: "Proof token",
        },
      });
      await db.appAvailabilityRule.create({
        data: { organizationId: orgId, name: "Proof rule" },
      });

      await svc.deleteOrganization(orgId, OWNER);

      await expect(
        db.organization.findUnique({ where: { id: orgId } }),
      ).resolves.toBeNull();
      await expect(
        db.organizationDomain.count({ where: { organizationId: orgId } }),
      ).resolves.toBe(0);
      await expect(
        db.organizationSsoConnection.count({
          where: { organizationId: orgId },
        }),
      ).resolves.toBe(0);
      await expect(
        db.organizationScimToken.count({ where: { organizationId: orgId } }),
      ).resolves.toBe(0);
      await expect(
        db.appAvailabilityRule.count({ where: { organizationId: orgId } }),
      ).resolves.toBe(0);
    });
  },
);
