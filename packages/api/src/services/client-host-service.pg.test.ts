import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `ClientHost` (Phase 4 relay stack) on REAL PostgreSQL. Two properties that
 * only show up against a real database, not the mocked-Prisma unit tests in
 * `gateway-client-cert.test.ts`:
 *
 * 1. The IDOR fence (`ensureClientHost`'s `where: { id, workspaceId }`)
 *    actually excludes a row scoped to a different workspace, exercised
 *    through the real `@onecli/db` client rather than a hand-rolled mock of
 *    Prisma's `findFirst`.
 * 2. The FK/cascade pg-proof the Phase 4 plan requires: deleting a workspace
 *    removes its `client_hosts` rows via the `ON DELETE CASCADE` on
 *    `client_hosts.workspace_id`, with NO change needed to the api-server's
 *    workspace-delete code path (`deleteWorkspaceContent` in
 *    `ee/services/workspace-service.ts` never mentions `client_hosts` — the
 *    DB-level FK does the work).
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type ClientHostService = typeof import("./client-host-service");

let db: Db;
let clientHostService: ClientHostService;

const P = "chs-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const FOREIGN_WORKSPACE = `${P}foreign-ws`;

const reset = async () => {
  await db.clientHost.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  clientHostService = await import("./client-host-service");
  await reset();

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.workspace.create({
    data: {
      id: FOREIGN_WORKSPACE,
      name: FOREIGN_WORKSPACE,
      organizationId: ORG,
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.clientHost.deleteMany({ where: { id: { startsWith: P } } });
});

describe.skipIf(!PROOF_URL)("ClientHost over real PostgreSQL", () => {
  it("ensureClientHost's IDOR fence: a hostId from another workspace 404s, not 200", async () => {
    const foreign = await clientHostService.ensureClientHost(
      FOREIGN_WORKSPACE,
      undefined,
      "foreign-host",
      undefined,
    );

    await expect(
      clientHostService.ensureClientHost(
        WORKSPACE,
        undefined,
        undefined,
        foreign.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ensureClientHost renewal reuses the same row when scoped to the owning workspace", async () => {
    const first = await clientHostService.ensureClientHost(
      WORKSPACE,
      undefined,
      "relay-1",
      undefined,
    );

    const renewed = await clientHostService.ensureClientHost(
      WORKSPACE,
      undefined,
      undefined,
      first.id,
    );

    expect(renewed.id).toBe(first.id);
    expect(renewed.spiffeUri).toBe(first.spiffeUri);

    const count = await db.clientHost.count({
      where: { workspaceId: WORKSPACE },
    });
    expect(count).toBe(1);
  });

  it("FK/cascade pg-proof: deleting a workspace cascades its client_hosts rows", async () => {
    const host = await clientHostService.ensureClientHost(
      WORKSPACE,
      ORG,
      "cascade-host",
      undefined,
    );

    const before = await db.clientHost.findUnique({ where: { id: host.id } });
    expect(before).not.toBeNull();

    // The real workspace-delete code path (`deleteWorkspace` /
    // `deleteWorkspaceContent` in `ee/services/workspace-service.ts`) never
    // deletes `client_hosts` explicitly — this proves the DB-level
    // `ON DELETE CASCADE` on `client_hosts.workspace_id` does that instead,
    // so a plain `workspace.delete` (as used here, and as Prisma issues it
    // inside that transaction) is sufficient with no code change.
    await db.workspace.delete({ where: { id: WORKSPACE } });

    const after = await db.clientHost.findUnique({ where: { id: host.id } });
    expect(after).toBeNull();

    // Recreate the workspace for any later test in this file/run.
    await db.workspace.create({
      data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
    });
  });

  it("client_hosts.organization_id FK is ON DELETE SET NULL, not CASCADE", async () => {
    // Workspace.organizationId is required (no ON DELETE CASCADE path exists
    // to exercise an organization delete without first deleting the
    // workspace, which would itself cascade the client_hosts row and mask
    // this FK's own action). Assert the constraint's delete action directly
    // instead — `confdeltype = 'n'` is Postgres's encoding for SET NULL,
    // matching the migration's `ON DELETE SET NULL` for this FK.
    const fkAction = await db.$queryRawUnsafe<{ confdeltype: string }[]>(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'client_hosts_organization_id_fkey'`,
    );
    expect(fkAction[0]?.confdeltype).toBe("n");

    const workspaceFkAction = await db.$queryRawUnsafe<
      { confdeltype: string }[]
    >(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'client_hosts_workspace_id_fkey'`,
    );
    expect(workspaceFkAction[0]?.confdeltype).toBe("c"); // 'c' = CASCADE
  });
});
