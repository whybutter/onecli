import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * Workspace agent-default-connections on REAL PostgreSQL: the template's own
 * constraints (unique per connection, cascade on workspace/connection delete)
 * plus the end-to-end apply step — a template written through
 * `setWorkspaceAgentDefault` and applied through `applyWorkspaceAgentDefaults`
 * must be readable back as a real grant via `getAgentGrants`, the same read
 * path the console and the gateway reflections use. Env-gated like the other
 * proof suites; see load-rules.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Defaults = typeof import("./agent-default-connections-service");
type Grants = typeof import("../../services/grants-service");

let db: Db;
let defaults: Defaults;
let grants: Grants;

const P = "adc-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const CONN = `${P}conn`;
const CONN_ORG = `${P}conn-orgshared`;
const CONN_FOREIGN = `${P}conn-foreign`;

const SCOPE = { workspaceId: WORKSPACE, organizationId: ORG };

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.workspaceAgentDefaultConnection.deleteMany({
    where: { workspaceId: { startsWith: P } },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const seedFixtures = async () => {
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.workspace.create({
    data: { id: OTHER_WORKSPACE, name: OTHER_WORKSPACE, organizationId: ORG },
  });
  const conn = (id: string, over: Record<string, unknown> = {}) =>
    db.appConnection.create({
      data: {
        id,
        provider: "gmail",
        scope: "workspace",
        status: "connected",
        workspaceId: WORKSPACE,
        label: id,
        ...over,
      },
    });
  await conn(CONN);
  await conn(CONN_ORG, {
    scope: "organization",
    workspaceId: null,
    organizationId: ORG,
  });
  await conn(CONN_FOREIGN, { workspaceId: OTHER_WORKSPACE });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  defaults = await import("./agent-default-connections-service");
  grants = await import("../../services/grants-service");
  await reset();
  await seedFixtures();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.workspaceAgentDefaultConnection.deleteMany({
    where: { workspaceId: { startsWith: P } },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
});

describe.skipIf(!PROOF_URL)(
  "workspace agent-default-connections (real PostgreSQL)",
  () => {
    it("setWorkspaceAgentDefault upserts — a second call on the same connection replaces the row, not duplicates", async () => {
      await defaults.setWorkspaceAgentDefault(
        SCOPE,
        CONN,
        { access: "full", resources: null },
        null,
      );
      await defaults.setWorkspaceAgentDefault(
        SCOPE,
        CONN,
        {
          access: "custom",
          allow: ["search_messages"],
          ask: [],
          resources: null,
        },
        null,
      );
      const rows = await db.workspaceAgentDefaultConnection.findMany({
        where: { workspaceId: WORKSPACE },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.access).toBe("custom");
    });

    it("rejects a connection outside the workspace's pool at the DB-fenced boundary", async () => {
      await expect(
        defaults.setWorkspaceAgentDefault(
          SCOPE,
          CONN_FOREIGN,
          { access: "full", resources: null },
          null,
        ),
      ).rejects.toThrow("Connection not found");
    });

    it("accepts an org-shared connection", async () => {
      await defaults.setWorkspaceAgentDefault(
        SCOPE,
        CONN_ORG,
        { access: "full", resources: null },
        null,
      );
      const list = await defaults.listWorkspaceAgentDefaults(SCOPE);
      expect(list.map((d) => d.connectionId)).toContain(CONN_ORG);
    });

    it("cascades on connection delete — a dropped connection can't leave a dangling template row", async () => {
      const conn = await db.appConnection.create({
        data: {
          id: `${P}cascade-conn`,
          provider: "gmail",
          scope: "workspace",
          status: "connected",
          workspaceId: WORKSPACE,
        },
      });
      await defaults.setWorkspaceAgentDefault(
        SCOPE,
        conn.id,
        { access: "full", resources: null },
        null,
      );
      await db.appConnection.delete({ where: { id: conn.id } });
      const rows = await db.workspaceAgentDefaultConnection.findMany({
        where: { connectionId: conn.id },
      });
      expect(rows).toHaveLength(0);
    });

    // phase2-plan WP-B: `deleteWorkspaceContent` needs no new line for this
    // table because the FK cascades from Workspace — this is the pg proof
    // that claim actually holds, not just a comment.
    it("cascades on WORKSPACE delete — deleteWorkspaceContent needs no new line for this table", async () => {
      const cascadeWorkspace = `${P}cascade-ws`;
      const cascadeConn = `${P}cascade-ws-conn`;
      await db.workspace.create({
        data: {
          id: cascadeWorkspace,
          name: cascadeWorkspace,
          organizationId: ORG,
        },
      });
      const conn = await db.appConnection.create({
        data: {
          id: cascadeConn,
          provider: "gmail",
          scope: "workspace",
          status: "connected",
          workspaceId: cascadeWorkspace,
        },
      });
      await defaults.setWorkspaceAgentDefault(
        { workspaceId: cascadeWorkspace, organizationId: ORG },
        conn.id,
        { access: "full", resources: null },
        null,
      );

      // A default on a workspace-owned connection would ALSO cascade via the
      // connection's own delete (deleteWorkspaceContent drops app_connections
      // before the workspace row) — that path is already proven by the
      // "cascades on connection delete" case above. To isolate the WORKSPACE
      // fk specifically, add a second default pointing at the ORG-SHARED
      // connection, which is untouched by anything scoped to this workspace
      // and so can only be cleaned up by the workspace_id fk itself.
      await defaults.setWorkspaceAgentDefault(
        { workspaceId: cascadeWorkspace, organizationId: ORG },
        CONN_ORG,
        { access: "full", resources: null },
        null,
      );
      const before = await db.workspaceAgentDefaultConnection.findMany({
        where: { workspaceId: cascadeWorkspace },
      });
      expect(before.length).toBeGreaterThan(0);

      await db.workspace.delete({ where: { id: cascadeWorkspace } });

      const after = await db.workspaceAgentDefaultConnection.findMany({
        where: { workspaceId: cascadeWorkspace },
      });
      expect(after).toHaveLength(0);
      // The org-shared connection itself must survive — only the template
      // row pointing at it from the deleted workspace is gone.
      const orgConnStillThere = await db.appConnection.findUnique({
        where: { id: CONN_ORG },
      });
      expect(orgConnStillThere).not.toBeNull();
    });

    it("end-to-end: a template applied at agent creation reads back as a real grant via getAgentGrants", async () => {
      await defaults.setWorkspaceAgentDefault(
        SCOPE,
        CONN,
        { access: "full", resources: null },
        null,
      );

      const agent = await db.agent.create({
        data: {
          id: `${P}new-agent`,
          workspaceId: WORKSPACE,
          name: "new agent",
          identifier: `${P}new-agent`,
          accessToken: "aoc_adc_test_token",
        },
      });

      await defaults.applyWorkspaceAgentDefaults(SCOPE, agent.id);

      const result = await grants.getAgentGrants(SCOPE, agent.id);
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0]).toMatchObject({
        connectionId: CONN,
        access: "full",
      });
    });

    it("removeWorkspaceAgentDefault: a removed default is no longer applied to a subsequently created agent", async () => {
      await defaults.setWorkspaceAgentDefault(
        SCOPE,
        CONN,
        { access: "full", resources: null },
        null,
      );
      await defaults.removeWorkspaceAgentDefault(SCOPE, CONN);

      const agent = await db.agent.create({
        data: {
          id: `${P}no-defaults-agent`,
          workspaceId: WORKSPACE,
          name: "no defaults agent",
          identifier: `${P}no-defaults-agent`,
          accessToken: "aoc_adc_test_token_2",
        },
      });
      await defaults.applyWorkspaceAgentDefaults(SCOPE, agent.id);

      const result = await grants.getAgentGrants(SCOPE, agent.id);
      expect(result.connections).toHaveLength(0);
    });
  },
);
