import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Resource scopes composed across levels, end to end through the real binary:
 * the ORGANIZATION sets a boundary and the WORKSPACE selects within it, so a
 * credential reaches the overlap of the two.
 *
 * The composed value is observable on the wire because an empty overlap is
 * refused with its own `resource_access_denied` 403 before anything else runs.
 * Every world here also seeds a workspace block rule on the same host, so the
 * NON-empty outcome answers `blocked_by_policy` instead — two distinct bodies
 * that say which composition the gateway actually computed. A boundary that
 * failed to bind, or one that replaced the workspace's pick rather than bounding
 * it, flips a test from one body to the other.
 *
 * Hermetic despite naming a real provider host: an app connection only enters
 * the injection pool for its own provider's hostname (so `127.0.0.1` cannot
 * exercise this at all), and both outcomes above refuse the request before any
 * socket is opened — the same trick `app-connections.test.ts` relies on.
 */

const GITHUB_HOST = "api.github.com";
const BLOCK_RULE = "block-github";

/** Guarantees no egress: whatever the scope composes to, the request stops at
 * the gateway. Also the discriminator — reaching it proves the scope was NOT
 * empty, because the empty-scope refusal runs first. */
const blockEverything = {
  name: BLOCK_RULE,
  action: "block" as const,
  targets: [{ hostPattern: GITHUB_HOST }],
};

/** The workspace's own grant of the connection, optionally carrying a selection. */
const grant = (resources?: { repositories: string[] }) => ({
  name: "grant: agent → connection",
  action: "allow" as const,
  source: "grant" as const,
  priority: 90,
  identities: ["agent" as const],
  targets: [{ kind: "connection" as const, connectionIndex: 0 }],
  ...(resources ? { resources } : {}),
});

/** An ORG rule naming NO identity — "applies to every agent", the shape an
 * administrator actually writes. */
const orgBoundary = (repositories: string[]) => ({
  name: "org: allowed repositories",
  action: "allow" as const,
  scope: "organization" as const,
  targets: [{ kind: "connection" as const, connectionIndex: 0 }],
  resources: { repositories },
});

const CONNECTIONS = [{ provider: "github-app", label: "acme" }];

const request = async (gw: { origin: string }, token: string) =>
  throughProxy(gw.origin, {
    url: `http://${GITHUB_HOST}/repos/acme/api`,
    token,
  });

const expectEmptyScope = (res: { status: number; body: string }) => {
  expect(res.status).toBe(403);
  const body: unknown = JSON.parse(res.body);
  expect(body).toMatchObject({ error: "resource_access_denied", allowed: [] });
  expect(JSON.stringify(body)).toContain("do not overlap");
};

/** Not refused for scope — the composition left something reachable, so the
 * request went on to the ordinary policy engine. */
const expectScopeSurvived = (res: { status: number; body: string }) => {
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body)).toMatchObject({
    error: "blocked_by_policy",
    rule_name: BLOCK_RULE,
  });
};

describe("resource boundaries (org ∩ workspace)", () => {
  scenario(
    "an org rule naming no identity bounds the agent: a disjoint workspace pick reaches nothing",
    async (cx) => {
      // THE reported shape. Before this change the org rule bound nothing (the
      // injection lane never matches an unnamed rule), so the workspace's pick
      // stood alone and this request was merely policy-blocked; now the scopes
      // compose to empty and it is refused for scope first.
      await cx.seed({
        appConnections: CONNECTIONS,
        rules: [
          orgBoundary(["acme/api"]),
          grant({ repositories: ["acme/secrets"] }),
          blockEverything,
        ],
      });
      const gw = await cx.startGateway();

      expectEmptyScope(await request(gw, cx.ids.agentToken));
    },
  );

  scenario(
    "a workspace pick inside the org boundary keeps its access",
    async (cx) => {
      // Composing must not over-block: the overlap is `acme/api`, so the scope
      // survives and the request reaches the policy engine.
      await cx.seed({
        appConnections: CONNECTIONS,
        rules: [
          orgBoundary(["acme/api", "acme/web"]),
          grant({ repositories: ["acme/api"] }),
          blockEverything,
        ],
      });
      const gw = await cx.startGateway();

      expectScopeSurvived(await request(gw, cx.ids.agentToken));
    },
  );

  scenario(
    "a plain org attach cannot evict the boundary by sorting later",
    async (cx) => {
      // Two unrelated org rows for one connection: the boundary, then a plain
      // attach carrying no scope. Last-match-wins would erase the boundary and
      // let the disjoint pick through — making access depend on the order of
      // rules that have nothing to do with each other.
      await cx.seed({
        appConnections: CONNECTIONS,
        rules: [
          orgBoundary(["acme/api"]),
          {
            name: "org: plain attach, no scope",
            action: "allow" as const,
            scope: "organization" as const,
            priority: 50,
            targets: [{ kind: "connection" as const, connectionIndex: 0 }],
          },
          grant({ repositories: ["acme/secrets"] }),
          blockEverything,
        ],
      });
      const gw = await cx.startGateway();

      expectEmptyScope(await request(gw, cx.ids.agentToken));
    },
  );

  scenario(
    "an org boundary bounds a connection the workspace alone granted",
    async (cx) => {
      // The org never grants this connection — it only constrains it. An
      // unrestricted workspace grant inherits the boundary rather than escaping
      // it, so a boundary of "nothing" reaches nothing.
      await cx.seed({
        appConnections: CONNECTIONS,
        rules: [orgBoundary([]), grant(), blockEverything],
      });
      const gw = await cx.startGateway();

      expectEmptyScope(await request(gw, cx.ids.agentToken));
    },
  );

  scenario(
    "an empty stored allowlist denies everything instead of minting unscoped access",
    async (cx) => {
      // The hole this closes: an empty list used to read as "no scoping
      // requested", and GitHub then minted a token for EVERY repository on the
      // installation. It must deny, before any credential is resolved.
      await cx.seed({
        appConnections: CONNECTIONS,
        rules: [grant({ repositories: [] }), blockEverything],
      });
      const gw = await cx.startGateway();

      expectEmptyScope(await request(gw, cx.ids.agentToken));
    },
  );

  scenario(
    "a provider-level grant is bounded too, though the boundary never names its ids",
    async (cx) => {
      // The other way to grant a connection: "all of this agent's github
      // connections at org level". Its ids are resolved from the database
      // AFTER the rules are folded, so a boundary applied only while folding
      // would be silently discarded — and the credential would go out
      // unbounded while the dialog reported it as restricted.
      await cx.seed({
        appConnections: CONNECTIONS,
        rules: [
          orgBoundary([]),
          {
            name: "grant: all github connections at workspace level",
            action: "allow" as const,
            source: "grant" as const,
            priority: 90,
            identities: ["agent" as const],
            targets: [
              {
                kind: "app" as const,
                provider: "github-app",
                connectionScope: "workspace" as const,
              },
            ],
          },
          blockEverything,
        ],
      });
      const gw = await cx.startGateway();

      expectEmptyScope(await request(gw, cx.ids.agentToken));
    },
  );

  scenario(
    "an org boundary binds without granting: an unattached connection stays unattached",
    async (cx) => {
      // The leak this design must avoid. Boundaries match rules that name
      // nobody; if that law also fed the GRANT fold, every unnamed org rule
      // would hand its credential to every agent. Here the org rule reaches
      // NOTHING and the agent has no grant — so if it wrongly granted, the
      // deny-all scope would attach and answer `resource_access_denied`.
      // Getting the ordinary policy block instead proves it granted nothing.
      await cx.seed({
        appConnections: CONNECTIONS,
        rules: [orgBoundary([]), blockEverything],
      });
      const gw = await cx.startGateway();

      expectScopeSurvived(await request(gw, cx.ids.agentToken));
    },
  );
});

/**
 * Dropbox's request-level folder guard, end to end (Phase 1 WP-C item F: the
 * `FolderPolicy` amendment — `gateway-ee-behaviour.md` §1.8).
 *
 * Unlike GitHub (token-scoped: an out-of-scope request never even reaches the
 * gateway's own check because the credential itself can't reach it), Dropbox
 * has no token-level scoping, so every request is inspected live against the
 * policy's `folders` allowlist. That guard's decode is the amendment under
 * test: `{folders: [42]}` (a non-empty array with no usable string entry) must
 * now deny everything, not read as "no restriction" (the Phase 0 spec gap).
 */

const DROPBOX_HOST = "api.dropboxapi.com";
const DROPBOX_BLOCK_RULE = "block-dropbox";
const DROPBOX_CONNECTIONS = [{ provider: "dropbox", label: "acme-dropbox" }];

/** Guarantees the request reached the ordinary policy engine (i.e. the
 * Dropbox guard did NOT deny it) — the discriminator between "unrestricted /
 * in scope" and "denied by the folder guard" for these scenarios. */
const blockDropbox = {
  name: DROPBOX_BLOCK_RULE,
  action: "block" as const,
  targets: [{ hostPattern: DROPBOX_HOST }],
};

const dropboxGrant = (resources?: { folders: string[] }) => ({
  name: "grant: agent → dropbox connection",
  action: "allow" as const,
  source: "grant" as const,
  priority: 90,
  identities: ["agent" as const],
  targets: [{ kind: "connection" as const, connectionIndex: 0 }],
  ...(resources ? { resources } : {}),
});

const dropboxRequest = (
  gw: { origin: string },
  token: string,
  path: string,
  body?: string,
) =>
  throughProxy(gw.origin, {
    url: `http://${DROPBOX_HOST}${path}`,
    token,
    method: body === undefined ? "GET" : "POST",
    body,
  });

const expectDropboxDenied = (
  res: { status: number; body: string },
  allowed: string[],
) => {
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body)).toMatchObject({
    error: "resource_access_denied",
    allowed,
  });
};

const expectDropboxScopeSurvived = (res: { status: number; body: string }) => {
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body)).toMatchObject({
    error: "blocked_by_policy",
    rule_name: DROPBOX_BLOCK_RULE,
  });
};

describe("Dropbox folder guard (FolderPolicy amendment)", () => {
  scenario(
    "a non-empty folders array with no usable string entries denies everything, even a pathless-allowed endpoint",
    async (cx) => {
      // Seed a valid (typed) folder first so the fixture builder accepts it,
      // then overwrite the stored conditions with the malformed shape
      // directly — `RuleSpec.resources.folders` is typed as
      // `ReadonlyArray<string>`, so `[42]` cannot be authored through the
      // typed fixture API (WP-A owns fixtures.ts; this WP seeds the gap via
      // `cx.db.prisma` directly, as instructed).
      await cx.seed({
        appConnections: DROPBOX_CONNECTIONS,
        rules: [dropboxGrant({ folders: ["/placeholder"] })],
      });
      await cx.db.prisma.policyRuleV2.update({
        where: { id: `${cx.ids.workspace}-rule-0` },
        data: { conditions: { folders: [42] } },
      });
      const gw = await cx.startGateway();

      // `/2/users/get_current_account` is on the PATHLESS allowlist — an
      // in-scope or unrestricted policy would allow it outright. DenyAll must
      // still deny it, proving the check runs before that allowlist.
      const res = await dropboxRequest(
        gw,
        cx.ids.agentToken,
        "/2/users/get_current_account",
      );
      expectDropboxDenied(res, []);
    },
  );

  scenario(
    "an explicitly empty folders array denies everything (the empty-scope refusal, ahead of the guard)",
    async (cx) => {
      await cx.seed({
        appConnections: DROPBOX_CONNECTIONS,
        rules: [dropboxGrant({ folders: [] })],
      });
      const gw = await cx.startGateway();

      const res = await dropboxRequest(
        gw,
        cx.ids.agentToken,
        "/2/users/get_current_account",
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ allowed: [] });
      expect(res.body).toContain("do not overlap");
    },
  );

  scenario(
    "folders: ['/'] is unrestricted — the request reaches the ordinary policy engine",
    async (cx) => {
      await cx.seed({
        appConnections: DROPBOX_CONNECTIONS,
        rules: [dropboxGrant({ folders: ["/"] }), blockDropbox],
      });
      const gw = await cx.startGateway();

      const res = await dropboxRequest(
        gw,
        cx.ids.agentToken,
        "/2/files/list_folder",
        JSON.stringify({ path: "/anything/at/all" }),
      );
      expectDropboxScopeSurvived(res);
    },
  );

  scenario(
    "a mix of garbage and valid folder entries restricts to the valid ones",
    async (cx) => {
      // No `blockDropbox` here on purpose: the ordinary policy engine (step 6)
      // decides before the granular guard ever runs (step 10), so a
      // host-level block rule would answer `blocked_by_policy` for EVERY
      // request regardless of what the guard would have decided — it cannot
      // discriminate "guard allowed" from "guard denied". The in-scope half
      // of this shape (`Restricted(["/valid"])` admits `/valid/sub`) is
      // pinned at the unit level instead
      // (`mixed_garbage_and_valid_folders_enforces_on_the_valid_entry` in
      // `crates/ee/ee/src/granular_access/dropbox.rs`); this scenario proves
      // the security-critical direction end to end: an out-of-scope path
      // under a policy that also carries a garbage entry is still denied,
      // with the garbage entry dropped (not fatal) from the reported
      // allowlist.
      await cx.seed({
        appConnections: DROPBOX_CONNECTIONS,
        rules: [dropboxGrant({ folders: ["/placeholder"] })],
      });
      await cx.db.prisma.policyRuleV2.update({
        where: { id: `${cx.ids.workspace}-rule-0` },
        data: { conditions: { folders: [42, "/valid"] } },
      });
      const gw = await cx.startGateway();

      const outOfScope = await dropboxRequest(
        gw,
        cx.ids.agentToken,
        "/2/files/list_folder",
        JSON.stringify({ path: "/elsewhere" }),
      );
      expectDropboxDenied(outOfScope, ["/valid"]);
    },
  );

  scenario(
    "a truncated request body must fail closed, never decide on whatever fit in the buffer",
    async (cx) => {
      // Phase 1 WP-C item E: `forward.rs` must hand the Dropbox guard `None`
      // for a truncated condition buffer, not the observed prefix. Without
      // that fix, this scenario does NOT come back 403: the truncated PREFIX
      // (bytes 0..4096) is on its own a syntactically complete, in-scope JSON
      // document — `{"path": "/clients/allowed"}` followed by nothing but
      // JSON whitespace — so a guard that trusts "whatever parsed" allows the
      // request through on a buffer that never actually observed whether the
      // real (truncated-away) tail of the wire body carries anything else.
      // `.filter(|b| !b.truncated)` makes ANY truncated body deny
      // unconditionally, independent of what happens to fit in the prefix.
      await cx.seed({
        appConnections: DROPBOX_CONNECTIONS,
        rules: [dropboxGrant({ folders: ["/clients"] })],
      });
      const gw = await cx.startGateway({
        env: { ONECLI_CONDITION_BODY_BUFFER_BYTES: "4096" },
      });

      const value = JSON.stringify({ path: "/clients/allowed" });
      // Total body > the 4096-byte cap (forces `truncated: true`); everything
      // past the closing `}` is pure whitespace, so the observed 4096-byte
      // prefix alone is complete, valid, in-scope JSON.
      const body = value + " ".repeat(4096 - value.length + 256);

      const res = await dropboxRequest(
        gw,
        cx.ids.agentToken,
        "/2/files/list_folder",
        body,
      );
      // The "cannot read request body" denial reports the POLICY's allowlist
      // (there is one — `/clients` — the guard just couldn't read the body
      // to check it), unlike the `DenyAll` denials above which report `[]`.
      expectDropboxDenied(res, ["/clients"]);
      expect(res.body).toContain("cannot read request body");
    },
  );
});
