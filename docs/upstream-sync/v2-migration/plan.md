# v2 migration plan

Decision (2026-09-14): the fork rebases onto upstream **v2.6.0** and replaces the three enterprise-licensed directories with its own implementations, written against the seams the Apache code already calls, and trimmed to our use case. This is the plan of record. The specs it is built from live next to it:

| Doc                       | What it is                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rust-seams.md`           | Every `ee::` item the free gateway crates call (22 items, 5 trait seams), signatures verbatim, wiring order, swap recipe                                            |
| `ts-seams.md`             | Every free→ee import in `packages/api`, `apps/api-server`, `apps/web` (47 static + 9 dynamic + 15 route wrappers), provider slots, route mounts, DB model ownership |
| `gateway-ee-behaviour.md` | What the gateway `ee` crate does at runtime: decision tables, failure posture, caching, constants, e2e tests to re-lane                                             |
| `api-ee-behaviour.md`     | HTTP contracts, invariants, side effects and audit events for every `packages/api/src/ee` feature                                                                   |
| `web-ee-behaviour.md`     | Every `apps/web/src/ee` surface: mount point, props, states, calls, gating, tests                                                                                   |

The previous review, `../reviews/2026-09-14-v2.6.0.md`, holds the why.

## Principles

1. **Clean room.** Implementers work from the behaviour specs and the free-side call sites, never from the licensed files. The specs describe contracts, not code. Anyone who has read an `ee/` file for a given area writes the spec, not the implementation, for that area.
2. **Same paths, same names.** The replacements live at `apps/gateway/crates/ee/ee`, `packages/api/src/ee`, `apps/web/src/ee` with the same module and export names. That makes the swap a zero-edit change to the free code and keeps future upstream merges tractable. The licence on those paths becomes Apache-2.0; `LICENSE-ENTERPRISE`, `NOTICE`'s exception paragraph and the three `ee/LICENSE` notices go.
3. **Always entitled.** There is no `ENTERPRISE_ENABLED`. `isEntitled()` and `common::edition::entitled()` return true; every unlicensed arm collapses to the licensed arm. The licensing test suites (`packages/api/src/licensing/*`, the ee snapshot) are retired, not re-snapshotted.
4. **Trim, don't port.** Cloud-only and billing code gets a null or no-op stand-in that keeps the free callers compiling. SSO, SCIM, Cognito, KMS, Redis HA, Stripe, AWS Marketplace, platform trial credit, analytics: all dropped.
5. **Nanoclaw is the agent runtime.** The runner profile stays off in our deployments and BYO agents are first-class in our UI. Upstream's hosted-agent surfaces stay in the tree, hidden by the existing "no runner registered" logic.
6. **Upstream stays mergeable.** After the cutover, `/upstream-sync` resumes against v2 releases. Our replacements touch only the three `ee/` roots plus a short list of free-file edits recorded in each phase, so a v2.7 merge conflicts only where upstream itself changed the seams.

## Scope: what the replacements contain

From the specs' KEEP / TRIM / DROP verdicts, consolidated. Anything not listed is DROP with a stand-in.

**Gateway crate (`crates/ee/ee`)**

| Module                                  | Verdict                    | Notes                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `granular_access` (+github, dropbox)    | KEEP                       | GitHub token-scoped via installation token, Dropbox request guard, `intersect_policies`, `denies_everything`. Decision tables in the gateway spec §1.                                                                                                   |
| `principals` (resolve)                  | KEEP                       | Org-fenced principal CTE: direct users ∪ group members, `status <> 'suspended'`. Fail-closed.                                                                                                                                                           |
| `principals` (availability)             | TRIM                       | Keep the pure `app_availability_block`; loader can return unrestricted until the admin page ships.                                                                                                                                                      |
| `rbac`                                  | KEEP                       | Always installed. Org-admin and workspace-manage rechecks on `oc_org_`/`oc_` keys.                                                                                                                                                                      |
| `budget`                                | KEEP + REWRITE eligibility | Spend, meter, pricing, response kept as specified. `binding.rs` eligibility redefined for org/workspace secrets (upstream keys it on the removed `partner` scope). Carry the fork's charge-time counter and reconcile-as-floor semantics.               |
| `org_routes`                            | KEEP minus the licence 403 | `GET /v1/org/approvals/pending`.                                                                                                                                                                                                                        |
| `response`                              | TRIM                       | Keep `budget_exceeded` (org arm), `app_unavailable`, `forbidden_resource`, `forbidden_empty_scope`. Drop `quota_exceeded` and the trial-credit arm (keep the fn signatures, return the org arm).                                                        |
| `ha`                                    | DROP                       | `check_ha_entitlement` → Ok; `redis_*_store` → `bail!("Redis HA is not supported in this build")`; the free in-memory stores stay.                                                                                                                      |
| `platform_llm`, `cognito`, `kms_crypto` | DROP                       | `configured_for_host` → false, `platform_credential` → None, `cognito::configured` → false, `KmsEnvelopeCrypto::from_env` → a backend whose methods error. Unit-struct and signature shapes preserved because `wiring.rs` constructs them positionally. |

**API (`packages/api/src/ee`)**

| Area                                                                         | Verdict                                                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Team/members (`/org/members`, team-service)                                  | KEEP; Cognito revocation arm becomes a constant                                                                                           |
| Authorization, workspace access, management guard (`/workspaces/:id/access`) | KEEP verbatim (the RBAC core)                                                                                                             |
| Workspace + organization services, default resolution                        | KEEP; quota-service removed (no org cap, no plan limits)                                                                                  |
| Groups + group→role mappings                                                 | KEEP groups; TRIM mappings to manual groups (no `scim` source)                                                                            |
| Granular access shape validators, policy-validator default                   | KEEP; Dropbox folder browser optional                                                                                                     |
| Domains (`/org/domains`, TXT verification)                                   | KEEP verbatim                                                                                                                             |
| App availability                                                             | TRIM / defer behind groups + bindings landing                                                                                             |
| Budget service                                                               | REWRITE as the fork's `budget-service` (mounted routes, org/workspace secrets)                                                            |
| SSO, SCIM, JIT, enforcement, `ssoExempt`, provisioning claims                | DROP; `enforceSsoSession` → null, `ensureSsoJitMembership` → no-op, `findSsoOrgForIdentity` → null, `createScimApp` → 404 app             |
| Notifications, Redis, KMS, Cognito, platform LLM, session hooks              | DROP; `eeSessionHooks` → the free onprem hooks                                                                                            |
| Billing, marketplace, reviewer, Resend webhooks                              | DROP; re-provide `normalizePlan`/`isPlanAtLeast`/`getPlanConfig`/`Plan` as constants so free callers compile, then simplify those callers |
| `registerEeRoutes`                                                           | Mounts only the kept routers; `requireEnterprise` becomes a pass-through                                                                  |

**Web (`apps/web/src/ee`)**

| Area                                                                                                     | Verdict                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groups pages and dialogs                                                                                 | KEEP; drop IdP badge copy                                                                                                                                                                                   |
| Org settings General (rename, id, owner delete)                                                          | KEEP; fix the admin-can-edit vs owner-only mismatch the spec found                                                                                                                                          |
| Org settings Domains                                                                                     | KEEP; strip SSO copy                                                                                                                                                                                        |
| Workspace access card + dialog                                                                           | KEEP; delete plan branch                                                                                                                                                                                    |
| `getUserOrgRole`, `changeTeamMemberRole`, `requireOrgAdmin`, team actions                                | KEEP                                                                                                                                                                                                        |
| ManageAccessDialog                                                                                       | TRIM to role only                                                                                                                                                                                           |
| Create org                                                                                               | KEEP (no cap)                                                                                                                                                                                               |
| Role mappings, App availability                                                                          | TRIM; deferred to the release after                                                                                                                                                                         |
| Granular access                                                                                          | TRIM; keep the `granularAccessConfigs` export and the GitHub picker                                                                                                                                         |
| SSO pages, Cognito/OTP auth, billing, budget UI, claim, request-app cloud arm, reviewer login, analytics | DROP with null/no-op stand-ins: `getResourceQuota` → `atLimit:false`, `QuotaLimitDialog`/`OverQuotaBanner`/`SidebarQuota`/`PlanBadge`/`TeamUpgradeBanner`/`PlanPaywallDialog` → null, `usePlanUsage` → null |

**Fork features to re-land on top** (no upstream twin, from the review's inventory)

| Feature                                                                  | Source                         | Size                                           |
| ------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------- |
| mTLS listener, CSR client certs, `relay` subcommand, cert↔token binding  | PRs #2–#5                      | 5–8 days gateway + api route on api-server     |
| Condition matching superset (body/header × contains/equals/regex/exists) | fork `condition_match.rs`      | 1–2 days                                       |
| Budgets with charge-time counters and reconcile-as-floor                 | fork PR #28 + wave-2 budget UI | 3–5 days (folded into the crate rewrite above) |
| Usage page + org aggregate endpoint                                      | PR #45                         | 1–2 days                                       |
| `ApiKey.lastUsedAt`                                                      | PR #50                         | 1 day                                          |
| Agent default connections                                                | PR #52                         | 1–2 days                                       |
| Install-page key masking                                                 | PR #36                         | 0.5 day                                        |
| Projects card grid extras (`ownerEmail`, counts)                         | PR #42/#43                     | 1 day, mostly already in v2's workspace list   |
| Webhooks receiver + pull queue                                           | PR #7                          | needs-decision, ~1 week                        |
| Vanta app                                                                | PR #1                          | needs-decision, 1–2 days                       |

## Repo strategy

- Merge #51 and #52 into today's `main` first so the 1.45 line is complete, then tag it `v1.45-fork-final` and keep it as branch `legacy/v1.45`.
- Create `v2` from the upstream tag `v2.6.0` (commit `8ea47cd` or the release commit). All migration work lands as a stacked PR series onto `v2`, one per phase below, each reviewed and QA'd per the team workflow.
- When Phase 6 passes, `main` is reset to `v2` and release-please continues from there. `docs/upstream-sync/state.json` `forkBase` becomes `v2.6.0`.
- The relay branches (#2–#5) and #7/#1 are closed against the old base and re-opened against `v2` when their phase comes.

## Phases

Each phase is one stacked PR (or a short stack), has a stated gate, and records the free files it had to touch outside `ee/` so the upstream-sync process knows the conflict surface.

### Phase 0: foundation (2–3 days)

Branch `v2` from v2.6.0. Make it _ours_ and _buildable_ without changing behaviour:

- Repo identity: every `github.repository == 'onecli/onecli'` guard, `ghcr.io/onecli/*` image refs in compose and `install.sh`, `onecli.sh/install` banners, in-app links listed in the deploy review, `cla.yml` and `ci-cache-seed.yml` deleted, `publish.yml` matrix trimmed to `web, api, gateway, migrations` (runner/agent/ssh/channel images dropped; the drift-guard test in `scripts/publish-workflow.test.mjs` updated to match).
- Licensing: delete `LICENSE-ENTERPRISE`, the three `ee/LICENSE` files, the NOTICE exception, the `LicenseRef` in `package.json` fields, `Cargo.toml` and the gateway Dockerfile label. Delete `packages/api/src/licensing/` and `scripts/cloud-boundary.test.mjs`. This is the commit where the licensed code is removed: **Phase 0 deletes the contents of the three `ee/` roots** and replaces them with compile-only stubs (every exported symbol present, returning the DROP stand-in). The tree must build and the free test suites must pass with the stubs.
- Entitlement: `isEntitled()` → true, `entitled()` → true, `ENTERPRISE_ENABLED` removed from compose, `.env.example`, docs, and the e2e harness.
- Bring over the fork's `.agents/skills/upstream-sync`, `docs/upstream-sync`, `docs/paid-parity`, CLAUDE.md, and the fork-is-OSS memory rewritten for the new reality.

Gate: `pnpm check`, `pnpm test`, `cargo test --workspace`, `gateway-e2e` free-surface suites green on the stubbed tree. Upstream's `unlicensed.test.ts` and `platform-llm.test.ts` deleted per the gateway spec §11.

### Phase 1: gateway `ee` crate (8–12 days)

Implement the KEEP modules from `gateway-ee-behaviour.md` against the signatures in `rust-seams.md`. Order: `rbac` → `principals` → `granular_access` → `org_routes`/`response` → `budget`. Fold in the fork's condition-matching superset (free crate `policy`, a documented free-file edit) and the reconcile-as-floor budget semantics.

Gate: the licensed-arm scenarios in `resource-boundary`, `control`, `policy` and `approval` e2e suites pass; new in-crate DB tests for the principal CTE, RBAC decision table and Dropbox guard per the spec's pinned edge cases.

### Phase 2: API `ee` (10–15 days)

Implement the KEEP areas from `api-ee-behaviour.md` against `ts-seams.md`'s provider slots and export surface. Order: authorization + workspace service (everything free depends on them) → team/members → groups → domains → granular shape validators → budget routes/service → `registerEeRoutes`. Re-land `lastUsedAt`, usage endpoint, agent defaults, `ownerEmail` here.

Gate: free route tests that import ee pass; new route tests per area covering the spec's HTTP contract and audit events; `org-departure-free`, `invitations-free`, `org-credentials-free` behaviours preserved as plain tests.

### Phase 3: web `ee` (8–12 days)

Implement KEEP/TRIM surfaces from `web-ee-behaviour.md`. Stand-ins for the DROP set already exist from Phase 0; this phase replaces the KEEP stubs with real pages and simplifies the free callers that only ever needed billing to be null. Re-land install-page masking and the usage page. Make BYO the primary create-agent door regardless of runner presence (documented free-file edit in `lib/agents/create-door.ts`).

Gate: browser QA over the org shell (Members, Groups, Domains, Settings, Workspaces sharing) and workspace shell (agents, connections, install) on the running dev stack, per the manual client-path checklist pattern from the project-lifecycle sprint.

### Phase 4: relay stack (5–8 days)

Re-home PRs #2–#5 onto v2: new crates `client-ca`, `relay`, `binding`; second `Entrypoint` impl; `POST /v1/gateway/client-cert` on the api-server; `client_hosts` migration keyed by `workspace_id`. Publish the gateway image with the `relay` subcommand. This closes the production gate recorded in the remote-gateway hardening effort.

Gate: relay round-trip against a remote gateway over raw TCP in a staging Dokploy; binding enforcement in `log` mode.

### Phase 5: auth, nanoclaw and deployment (4–6 days)

- **Auth policy.** v2 forces open email/password registration. Add an instance setting (`ONECLI_REGISTRATION=open|invite`, default `invite`) enforced in the free better-auth config (signup allowed only when the email has a pending invitation, or the instance has no users yet) and honoured by the signup page; Google stays enabled when configured. Documented free-file edit.
- **Nanoclaw.** `ONECLI_URL` moves to the api-server origin or a path-routed single origin; setup installs our compose (four images) instead of upstream's installer; `versions.json` pin bumped to our published gateway; remote mode per nanoclaw #34 with our relay image. The health probe must hit the api-server, not the web app's probe alias.
- **Deployment.** Dokploy stack for Graphite: postgres, migrations, api, web, gateway; single HTTPS origin routing `/v1` and `/auth` to api, `/gw` to gateway, rest to web; gateway CONNECT port exposed raw-TCP only to the relay's mTLS listener.

Gate: a nanoclaw host in remote mode completes an agent turn with an injected credential against the staging stack.

### Phase 6: cutover (1–2 days; fresh database per decision 5)

- Fresh database. Our own migrations (`client_hosts`, `agent_default_connections`, `api_keys.last_used_at`, `invitations.workspace_id`) sit after upstream's chain. The 1.45 data is not carried forward; `legacy/v1.45` keeps that deployment readable until it is retired.
- Bring the instance up with registration `invite`, create the owner account, invite the team.
- Cut `main` over to `v2`, tag, publish images, update `state.json`.

Gate: full browser QA on the fresh instance; nanoclaw regression on the fork's own hosts.

## Estimate

Roughly **35–55 engineer-days** end to end (Phase 6 shrank to a cutover), Phases 1–3 dominating. Phases 1 and 2 can run in parallel after Phase 0 since they share only the spec; Phase 3 depends on Phase 2's export surface. Phase 4 depends on Phase 1.

## Decisions (Marco, 2026-09-14)

1. **Registration:** instance setting, default **invite-only**. Existing members send invite links; Google login works for invited emails; the public signup form is off unless the setting says `open`.
2. **Multi-org:** **no cap.** Any user may create organizations; the create-org page ships in Phase 3; `MAX_ORGS_PER_USER` and the quota-service org limit are removed rather than defaulted.
3. **App availability:** **deferred.** Not in the first cut; the gateway keeps the pure block function and an always-unrestricted loader.
4. **Webhooks (#7):** **next version**, after the cutover. **Vanta (#1):** parked.
5. **Data:** there is a live 1.45 database, but a **fresh start is acceptable.** Phase 6 becomes a cutover, not a migration; the 1.45 data stays readable on `legacy/v1.45` for as long as that deployment is kept.
6. **Redis:** dropped; single gateway instance is the known ceiling.

## First-cut priorities

What ships in the first v2 release, in order. Everything KEEP in the scope tables above is still in scope; this is the sequence within it, chosen so that each step unblocks the next and the nanoclaw path lights up earliest.

| #   | Slice                                                                                              | Why here                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Phase 0 foundation                                                                                 | Nothing else builds without it.                                                                          |
| 2   | Authorization + workspace service (API), `rbac` + `principals` (gateway)                           | Every free route and the sidebar depend on these; RBAC is the reason the fork exists.                    |
| 3   | Team/members + invitations + invite-only registration                                              | Lets a real team onto an instance safely.                                                                |
| 4   | Granular access (gateway + API validators + GitHub picker)                                         | The one place unlicensed v2 silently injects broad tokens; must be closed before any real agent traffic. |
| 5   | Groups + workspace access bindings (API + web)                                                     | Completes the RBAC story; needed by the principal query to mean anything.                                |
| 6   | Domains                                                                                            | Ships in the fork today; small and self-contained.                                                       |
| 7   | Nanoclaw repoint + four-image compose + Dokploy staging                                            | First end-to-end agent turn on v2.                                                                       |
| 8   | Relay stack (Phase 4)                                                                              | Graphite's remote gateway; gated on 2 and 7.                                                             |
| 9   | Budgets (gateway rewrite + API routes + UI), usage page, `lastUsedAt`, agent defaults, key masking | Fork extras with no upstream twin; none block the cutover.                                               |
| 10  | Cutover (Phase 6, fresh database)                                                                  |                                                                                                          |

Deferred to the release after: webhooks, app availability, role mappings, Vanta.
