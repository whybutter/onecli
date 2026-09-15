# Phase 0 (foundation) implementation plan — v2 migration

Worktree: `/Users/marco/Projects/ai-agents/onecli/.claude/worktrees/v2-phase0` (branch `phase0/foundation`, HEAD `ce9dca4` / v2.6.0, commit `8ea47cd` + release-please bump). All paths below are relative to that worktree unless marked "(old tree)" for `/Users/marco/Projects/ai-agents/onecli`.

## Executive summary — corrections to the brief, found by reading the actual tree

1. **`getUserOrgRole`/workspace-CRUD are not optional stubs.** `packages/api/src/routes/workspaces.ts` and `apps/web/src/lib/workspaces/actions.ts` import `ee/services/workspace-service`, `ee/services/authorization-service`, `ee/services/workspace-management-guard` **unconditionally — no `isEntitled()`/`IS_CLOUD` gate at the call site** (verified by reading both files). These are the actual backing implementation of the free `/v1/workspaces` CRUD and the org/workspace bootstrap path (`ensureUserDefaultOrgAndWorkspace`). A null/throwing stub here does not "keep free callers compiling," it makes the product unable to create or list a workspace at all, which will fail `pnpm test` (`routes/workspaces.test.ts` is in ts-seams §A.7) and blocks manual smoke-testing of the "buildable" tree. **WP3 must ship a real, minimal (direct-membership-only, no groups, no quota) implementation of these three modules in Phase 0**, not a placeholder. This is the single biggest deviation from "compile-only stub" in the whole phase — see Risk 1.
2. **`RbacRoleResolver::{user_is_org_admin, user_can_manage_workspace} → Ok(true)` for both methods is provably safe**, not a guess. Read `apps/gateway/crates/context/src/auth.rs:448-460` and `:551-562`: when `ROLE_RESOLVER.get()` is `None` (today's unlicensed-onprem default), the role recheck is skipped entirely, i.e. treated as allow. `Ok(true)` from an installed resolver is byte-for-byte the same outcome. Ship it as specified in plan.md.
3. **`ee::granular_access::{denies_everything, intersect_policies}` and `ee::principals::find_principal_set` cannot be naive DROP stubs.** Once `common::edition::entitled()` is hard-coded `true` in Phase 0, the free call sites that today only run on a _licensed_ onprem box (rare) start running on **every** box, unconditionally. `crates/policy-engine/src/inject_select.rs` has two in-crate `#[test]` functions (`a_workspace_pick_outside_the_org_boundary_denies_everything` and its neighbour) that call these functions directly and are part of `cargo test --workspace` — a **hard Phase 0 gate**, not a Phase-1-deferred e2e suite. A naive `a.cloned().or(b.cloned())` stub compiles but (a) fails those two tests and (b) is a real security regression once it's live (it would let an org-boundary policy silently override a tighter workspace-level grant instead of computing the intersection). Similarly `find_principal_set` is called whenever `entitled && has_non_agent_identity(...)` — now unconditionally — so returning an empty `PrincipalSet` would silently strip direct-user grants that work today. WP2 must ship small, _correct-for-the-exact-match case_ (not full prefix-containment — that's still Phase 1) implementations of these two functions. See §2 and Risk 2/3 for the exact algorithms.
4. **`.env.example` and `docs/self-hosting.md` do not currently reference `ENTERPRISE_ENABLED`** (grepped, no hits) — the brief's file list is stale for these two; don't spend WP time hunting for text that isn't there. The full, verified list of files referencing `ENTERPRISE_ENABLED` is in §Test-and-file-triage below.
5. **`scripts/install-sh.test.mjs`, `scripts/upgrade-parity.test.mjs`, `scripts/deploy-workflows.test.mjs` need _zero_ changes**, given the WP1 design decision in §0.A (keep `runner`/`ssh-terminator`/`channel-adapter`/`agent` pointed at upstream's `ghcr.io/onecli/onecli-*` images, since we don't build them and they're already `profiles: ["runner"]`/`["channel-adapter"]`-gated, off by default). All three tests only assert the `RUNNER_AGENT_IMAGE` default, which stays upstream-branded unchanged. `deploy-workflows.test.mjs` is already a permanent no-op here (`skip: !inCloudRepo`, and this repo's `package.json` name is `"onecli"`, not `"onecli-cloud"`). **Only `scripts/publish-workflow.test.mjs` needs a real rewrite.**
6. Root `package.json`'s "check" script runs `pnpm run test:licensing` (→ `pnpm --filter @onecli/api test:licensing` → `vitest run src/licensing`), and there is **no `test:licensing` entry in `turbo.json`** (checked — the brief's "and turbo" instruction has nothing to remove there; just double check at implementation time in case a package-level `turbo.json` pipeline references it).
7. `apps/gateway-e2e/src/env.ts` currently makes `E2E_REDIS_HOST` a **required** var (throws in CI when unset). Decision 6 in plan.md permanently drops Redis, so this needs a free-file edit (outside the ee roots) to make Redis optional in the harness — otherwise CI can never run the suite at all post-Phase-0. See WP1.

---

## 0. Design decisions this plan makes (state these back to Marco before merging)

**A. Runner/ssh-terminator/channel-adapter/agent images stay pointed at upstream `ghcr.io/onecli/onecli-*`.** Evidence: in `docker/docker-compose.yml` these three services are already `profiles: ["runner"]` / `["channel-adapter"]` (off by default, lines 285-286, 348-349, 402-403); we do not build them (plan.md decision 5: nanoclaw/BYO is the runtime, hosted-agent runner stays off); `scripts/lib/upgrade.mjs:47` and `scripts/install.sh:350` already hard-code only the **agent** image upstream-branded and nothing else. Keeping these four Dockerfiles (`docker/{agent,runner,ssh-terminator,channel-adapter}.Dockerfile`) in the tree unchanged (they're still used by `docker/docker-compose.build.yml`, `apps/hosted-e2e`, and `.github/workflows/ci-cache-seed.yml` for local/dev builds — grepped, confirmed) and letting `publish.yml`'s matrix diverge from the full Dockerfile set is the least-churn option. Alternative (delete the 4 Dockerfiles, drop the services from compose entirely) is bigger blast radius for no Phase-0 benefit; not recommended.
**B. `docker/docker-compose.legacy.yml` (the pre-2.0 all-in-one image) is left untouched in Phase 0.** It supports upgrading an existing all-in-one onecli container, which is not our fork's cutover path (Decision 5 in plan.md: fresh database, `legacy/v1.45` stays readable separately). Not part of the publish matrix, not referenced by any drift-guard test. No action needed for buildability; flag for later cleanup/removal, not urgent.
**C. Marketing/install-domain strings (`onecli.sh`, `app.onecli.sh`, `team@onecli.sh`, `sales@onecli.sh`) are NOT changed in Phase 0 — open decision needed from Marco.** The brief assumes a replacement is obvious; it isn't given in any doc I read. `github.repository == 'whybutter/onecli'` and `ghcr.io/whybutter/onecli-*` ARE decided (plan.md states the repo is `whybutter/onecli`); the install curl-domain and support email are not. WP1 changes only the GH-repository-identity and ghcr.io-namespace strings; it leaves `onecli.sh`/`app.onecli.sh`/support-email strings in place with a `// TODO(marco): replacement domain` comment where practical, or ask before touching them. Do not guess a domain.
**D. Workspace-service/authorization-service (WP3a) get a real, minimal (no groups, no quota, direct-membership-only) implementation in Phase 0**, not a stub — see Executive Summary #1 and Risk 1. This is a deliberate, documented deviation from "compile-only stub" for exactly the three modules where a stub would break the product outright.

---

## 1. Work packages

Grouped so 3-4 agents can work on disjoint files with minimal merge conflicts. **WP2 (Rust) and WP3 (API) and WP4 (web) all only ever touch files under their own `ee/` root plus their own free-file edit list — no two WPs touch the same file** except the root `package.json`/`turbo.json` (WP1) and `CLAUDE.md`/docs (WP1, sequenced last since it documents the others' output).

### WP1 — Repo identity, licensing metadata, CI/publish, bring-over (S/M, ~1-1.5 days, can start immediately, no dependency on WP2-4 except CLAUDE.md's content)

**1a. Repo/CI identity (S)**

- `.github/workflows/release.yml:19` — `github.repository == 'onecli/onecli'` → `'whybutter/onecli'`.
- `.github/workflows/publish.yml:28,103` — same guard string; trim the two `service: [web, gateway, api, migrations, runner, agent, channel-adapter, ssh-terminator]` matrix lines to `service: [web, api, gateway, migrations]` (keep both lines identical, per existing test #1).
- Delete `.github/workflows/cla.yml`, `.github/workflows/ci-cache-seed.yml`, `CLA.md`. (Verify `ci-cache-seed.yml` is only cache-warming, not a required dependency of `ci.yml`'s pass/fail — it isn't; `ci.yml`'s restore-keys degrade gracefully to a cold cache.)
- `scripts/publish-workflow.test.mjs` — full rewrite, three changes:
  - Repo-guard regex: `'onecli\/onecli'` → `'whybutter\/onecli'`.
  - Replace `assert.deepEqual(new Set(dockerfiles), services)` (test "the matrix equals the docker/\*.Dockerfile set") with: `services` (now 4) must be a **subset** of `dockerfiles` (still 8, since we keep the 4 unused Dockerfiles per decision 0.A), AND assert the excluded set explicitly: `assert.deepEqual(new Set([...dockerfiles].filter(d => !services.has(d))), new Set(["runner", "agent", "channel-adapter", "ssh-terminator"]))` — this still catches a stray new Dockerfile with no wiring, while accepting the four known upstream-passthrough images.
  - Rewrite "every image the compose pulls is in the matrix": scan for **two** registries — `ghcr\.io\/whybutter\/onecli-([a-z0-9-]+):` (must all be in `services`) and `ghcr\.io\/onecli\/onecli-([a-z0-9-]+):` (must all be in the known-excluded set `["runner","agent","channel-adapter","ssh-terminator"]`, i.e. explicitly NOT in `services` — this is the assertion that keeps the two-registry split honest). Keep the existing `assert.ok(pulled.includes("agent"))`-style check but against the upstream-branded pull list.
- `docker/docker-compose.yml` — lines 41, 63, 179, 229: `ghcr.io/onecli/onecli-{migrations,api,web,gateway}` → `ghcr.io/whybutter/onecli-{migrations,api,web,gateway}`. Lines 287, 310, 350, 404 (runner/agent/ssh-terminator/channel-adapter) — **leave unchanged** (decision 0.A).
- `scripts/install.sh` — line 55-56: `COMPOSE_URL_NEW`/`COMPOSE_URL_LEGACY` `raw.githubusercontent.com/onecli/onecli/main/...` → `.../whybutter/onecli/main/...`. Line 4: `# Source: https://github.com/onecli/onecli` → `whybutter/onecli`. Line 350 (`ghcr.io/onecli/onecli-agent` default) and the `onecli.sh/install` banners (lines 7,12,16,20,26,30,34,43,581,707,722,827) — leave per decision 0.C pending Marco's call on the install domain.
- `scripts/setup/wizard.mjs` — grep-verify the one hit found (`grep -n "runner.Dockerfile\|..."` matched it only for Dockerfile path references, not identity strings — re-grep for `onecli/onecli`/`ghcr.io/onecli` specifically before editing; likely no change needed).
- In-app links — verified by direct grep, exact lines to change:
  - `apps/web/src/lib/dashboard/dashboard-header.tsx:328` — `href="https://github.com/onecli/onecli"` → `https://github.com/whybutter/onecli`.
  - `apps/web/src/lib/install-command.ts:5`, `apps/web/src/lib/dashboard/sidebar-version.tsx:26`, `apps/web/src/lib/dashboard/dashboard-header.tsx:308`, `apps/web/src/lib/components/cloud-upsell.tsx:25`, `packages/api/src/services/invitation-email.ts` (6 hits) — all use `onecli.sh`/`app.onecli.sh`/`team@onecli.sh` domain strings, not GitHub-repo identity. **Leave per decision 0.C** — flag to Marco, don't guess.
  - `apps/web/src/lib/agents/create-door.ts`, `packages/api/src/services/agent-service.ts` — **grepped, zero hits for any onecli/onecli or ghcr.io/onecli or onecli.sh string.** The brief's file list included these; they don't need changes. Don't waste time here.

**1b. Licensing metadata (S)**

- Delete: `LICENSE-ENTERPRISE`, `apps/web/src/ee/LICENSE`, `packages/api/src/ee/LICENSE`, `apps/gateway/crates/ee/LICENSE`.
- `NOTICE` — delete the "Certain paths are NOT licensed..." + "The OneCLI Enterprise License permits..." + "For enterprise licensing enquiries..." paragraphs (lines ~12-26 per the read above); keep the Apache header and third-party-notices section (needed by `packages/api/src/licensing/third-party-notices.test.ts` — see test triage, this test is KEPT).
- `README.md` lines 119-126 ("## License" section) — replace with a single-licence statement: `[Apache-2.0](LICENSE).` (drop the enterprise-exception paragraph entirely).
- `package.json:43`, `apps/web/package.json:6`, `packages/api/package.json:5` — `"license": "Apache-2.0 AND LicenseRef-OneCLI-Enterprise"` → `"license": "Apache-2.0"`.
- `apps/gateway/crates/ee/ee/Cargo.toml` — `license = "LicenseRef-OneCLI-Enterprise"` → `"Apache-2.0"` (WP2 territory but trivial, can be done by WP1 or WP2 — assign to WP2 since it edits the same file WP2 rewrites wholesale).
- `apps/gateway/crates/onecli-gateway/Cargo.toml:7` — `license = "Apache-2.0 AND LicenseRef-OneCLI-Enterprise"` → `"Apache-2.0"`.
- `apps/gateway/Cargo.toml:31-37` — rewrite the "ENTERPRISE-LICENSED" comment block header to something neutral (e.g. "formerly enterprise-licensed, now Apache-2.0 like everything else — kept as a separate member because the free crates depend on it by path and Cargo can't glob-exclude a single member"); the crate **stays** a workspace member at the same path (`crates/ee/ee`) — this is the "same-path swap," not a relocation (rust-seams §H, option 1).
- `docker/gateway.Dockerfile:35` — `LABEL org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-OneCLI-Enterprise"` → `"Apache-2.0"`.
- Delete `packages/api/src/licensing/` **entirely** (all 10 files + `__snapshots__/`), and `scripts/cloud-boundary.test.mjs`.
- Root `package.json`: remove `"test:licensing": "pnpm --filter @onecli/api test:licensing"` script and its invocation inside `"check": "turbo run lint check-types && pnpm run format:check && pnpm run test:scripts && pnpm run test:licensing"` → drop the trailing `&& pnpm run test:licensing`.
- `packages/api/package.json` — remove its own `"test:licensing": "vitest run src/licensing"` script (dead once the dir is gone). Leave `"test:scim"` as-is for now (WP3 will delete/rewrite the underlying files it points at — see test triage — but the script line itself is harmless to leave until then, or delete in the same WP3 pass since it references `src/ee/scim` which WP3 stubs to a 404 app with no meaningful tests to run).
- Confirmed **no other importer** of `packages/api/src/licensing/**` outside itself except a comment (not a code import) in `packages/api/src/testing/hermetic-env.test.ts:98` — optional cosmetic edit, not required for build.

**1c. Entitlement env cleanup (S)**

- `docker/docker-compose.yml` lines 88-90, 198-200, 246 — remove the `ENTERPRISE_ENABLED: ${ENTERPRISE_ENABLED:-}` lines and their comments (3 occurrences).
- `scripts/dev.mjs` lines 331, 446 — remove the `ENTERPRISE_ENABLED` branch/mention (line 446's message listing three edition options collapses to two, or to a single sentence, since entitlement is no longer optional).
- `apps/gateway-e2e/src/gateway.ts:226` — remove `ENTERPRISE_ENABLED: "true"` from the spawned env (no longer meaningful once `entitled()` is hardcoded true).
- `apps/gateway-e2e/README.md` — rewrite the paragraphs describing the "unlicensed lane" / `ENTERPRISE_ENABLED=true` semantics (lines ~19-28) since `unlicensed.test.ts` is deleted in this phase (see test triage) and there is no more licensed/unlicensed split to describe.
- `apps/hosted-e2e/src/api-server.ts:55`, `apps/hosted-e2e/src/gateway.ts:65` — remove `ENTERPRISE_ENABLED: "true"`.
- `apps/hosted-e2e/README.md` — check for prose referencing it (grepped, file matched; verify content at implementation time).
- `apps/gateway-e2e/src/env.ts` — **free-file edit, documented**: make `E2E_REDIS_HOST` optional (drop it from the `missing` check and from `WHY`), so the harness never requires Redis. `resolve()`'s returned `redisHost` becomes `read("E2E_REDIS_HOST") ?? ""` (empty → `gateway.ts:232` sets `REDIS_HOST: ""` → free in-memory stores, matching decision 6). This unblocks CI once Redis is fully dropped.
- `packages/api/src/lib/entitlements.ts` — `isEntitled()` body → `return true;` (delete the `testOverride`/env-parsing logic, or keep `initEntitlementForTests` as a harmless no-op if any surviving test still calls it — check after WP3's test triage pass, since `parseEntitled`/`ENTERPRISE_FEATURES`/`isEnterpriseFeature` types are still imported elsewhere (e.g. `enterprise-locked-card.tsx`) and should stay exported even though the runtime check is now constant-true). Keep the function signature and all exports (`ENTERPRISE_FEATURES`, `EnterpriseFeature`, `isEnterpriseFeature`) — only the body of `isEntitled()` changes, per plan.md Principle 3 ("keep the function, callers untouched").
- `apps/gateway/crates/common/src/edition.rs` — `entitled()` body → `true` (delete `parse_entitled`/env read, or keep `parse_entitled` for its own unit tests but have `entitled()` ignore it and return `true` unconditionally — cleanest is to delete `parse_entitled` and its tests and make `entitled()` a one-line `true`). Keep `edition()`/`Edition` untouched (still reads `EDITION` env — we are NOT collapsing Cloud/Onprem, just entitlement).
- CAPS: **no code change needed.** `packages/api/src/lib/env.ts:43` (`CAPS = capabilitiesFor(EDITION_INFO, { entitled: isEntitled() })`) picks up `rbac: true` automatically once `isEntitled()` is hardcoded true. `apps/web/src/lib/env.ts:42` (`CAPS = capabilitiesFor(EDITION_INFO)`, no `entitled` arg) is **intentionally unaffected** — by design the client bundle never gets entitlement baked in (see the doc-comment in `entitlements.ts`); web reads entitlement from `GET /v1/instance` via `useInstance()`/`PlanGate` instead. Do not "fix" this to also pass entitled=true; that would violate the documented client-bundle-safety invariant.

**1d. Bring-over (S, do last so it can describe WP2-4's actual output)**

- Copy from old tree `/Users/marco/Projects/ai-agents/onecli`: `.agents/skills/upstream-sync/**` (5 skill dirs exist there: `find-skills`, `frontend-design`, `upstream-sync`, `vercel-react-best-practices`, `web-design-guidelines` — copy only `upstream-sync`, the others are generic Claude-Code skills unrelated to this fork and likely already present or irrelevant in the new tree; confirm the new tree's own `.agents/skills` state before copying to avoid duplicating unrelated skills), `.claude/skills/upstream-sync` (recreate the symlink `-> ../../.agents/skills/upstream-sync`), `docs/upstream-sync/**` (README.md, reviews/, v2-migration/, state.json), `docs/paid-parity/**` (6 files), `docs/nanoclaw-integration.md`.
- **Do NOT copy** the old tree's `docker/Dockerfile`/`entrypoint.sh` (all-in-one legacy artifacts, obsoleted by v2's multi-image topology) — per the brief's explicit instruction.
- `docs/upstream-sync/state.json` — update `forkBase` to `v2.6.0` once Phase 0 lands (plan.md repo-strategy section) — do this as part of this WP since it's a one-line JSON edit, or leave for Phase 6 per plan.md's literal text ("When Phase 6 passes... state.json forkBase becomes v2.6.0") — **recommend leaving it for Phase 6** since Phase 0 is not yet the cutover; just bring the file over unmodified.
- `CLAUDE.md` — full rewrite for v2. Required sections per the brief: (1) structure — `apps/{web,api-server,gateway,gateway-e2e,hosted-e2e}`, `packages/{api,db,ui}`, replacing the old fork's file map; (2) commands — pull the real ones from the new tree's root `package.json` scripts (`pnpm dev`, `pnpm build`, `pnpm check`, `pnpm test`, gateway's `cargo test --workspace` in `apps/gateway`); (3) the "independent fork" section rewritten to state: `ee/` directories under `apps/web/src/ee`, `packages/api/src/ee`, `apps/gateway/crates/ee/ee` are OURS, Apache-2.0, no `ENTERPRISE_ENABLED` switch exists, entitlement is always on; the `runner`/`ssh-terminator`/`channel-adapter` hosted-agent stack stays in the tree but off by default (`profiles:` gated, not part of the publish matrix); nanoclaw/BYO agents are the primary and only agent runtime this fork ships. Reference `docs/upstream-sync/v2-migration/plan.md` as the living roadmap.

### WP2 — Rust gateway `ee` crate (M, ~1.5-2 days; the security-critical package — see Risk 2/3)

Files touched, all under `apps/gateway/crates/ee/ee/` plus the one Cargo.toml metadata line already listed in 1b:

- **Delete** `apps/gateway/crates/ee/ee/src/{budget,granular_access,ha,principals}/` (the four private submodule directories) and all 10 top-level `.rs` files; replace with 10 flat files matching `lib.rs`'s existing `pub mod` list exactly (no submodules needed — none of the REF items require them):

  `lib.rs`: unchanged content (`pub mod budget; pub mod cognito; pub mod granular_access; pub mod ha; pub mod kms_crypto; pub mod org_routes; pub mod platform_llm; pub mod principals; pub mod rbac; pub mod response;`).

  `budget.rs` — **REAL types, DORMANT logic** (budget stays inert until Phase 1's REWRITE):

  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum BudgetPeriod { Monthly, Total }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(into = "String", try_from = "String")]
  pub enum BudgetSubject { Org(String), User(String) }
  // + impl Display, impl From<BudgetSubject> for String, impl TryFrom<String> for BudgetSubject
  // — copy the exact `org:<id>`/`user:<id>` encode/decode rule from rust-seams §A.1; this is
  // real, pure, no I/O, no reason to fake it.

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct BudgetBinding {
      pub secret_id: String,
      pub subject: BudgetSubject,
      pub secret_type: String,
      pub limit_nanos: i64,
      pub period: BudgetPeriod,
  }

  pub trait BudgetSecret { fn id(&self) -> &str; fn scope(&self) -> &str; fn secret_type(&self) -> &str; }
  impl BudgetSecret for db::SecretRow { /* same field mapping as upstream */ }

  pub async fn resolve_bindings<S: BudgetSecret>(
      _pool: &sqlx::PgPool, _org_id: &str, _secrets: &[S], _entitled: bool,
  ) -> Vec<BudgetBinding> { Vec::new() } // DROP stand-in — Phase 1 REWRITE fills this in

  pub fn has_meter(_secret_type: &str) -> bool { false }
  pub async fn is_over_budget(_cache: &dyn cache::CacheStore, _pool: &sqlx::PgPool, _binding: &BudgetBinding) -> bool { false }

  pub fn wrap_metered(
      _binding: &BudgetBinding, meta: telemetry::core::RequestMeta, _is_sse: bool,
      stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
  ) -> context::BodyStream {
      // Unreachable in Phase 0 (has_meter is always false, so hooks.rs never calls this),
      // but must preserve the invariant if it ever is: emit telemetry::on_request exactly
      // once at stream end, with no charge (mirrors the free "not wrapping" path).
      // Implement as a passthrough wrapper around `stream` that calls
      // telemetry::on_request(meta.into_event(None)) in its Drop/on-end handler, then
      // forwards bytes unchanged. Do NOT double-emit — hooks.rs's non-wrapped path already
      // calls telemetry::on_request itself; wrap_metered is the ONLY call site that emits
      // when a binding exists, so this is safe as its own emission point.
  }

  pub struct BudgetSpendSink;
  #[async_trait::async_trait]
  impl telemetry::SpendSink for BudgetSpendSink {
      async fn add_spend(&self, _cache: &dyn cache::CacheStore, _pool: &sqlx::PgPool, _secret_id: &str, _subject: &str, _period_key: &str, _nanos: i64) {}
      // no-op: nothing ever calls this in Phase 0 since resolve_bindings is always empty,
      // but install it anyway (wiring.rs installs unconditionally) rather than leave the
      // sink slot empty and trigger telemetry's "no spend sink installed" warning noise.
  }
  ```

  `cognito.rs`:

  ```rust
  pub fn configured() -> bool { false } // honest: never configured in an onprem-only fork
  pub struct CognitoSessionValidator;
  #[async_trait::async_trait]
  impl context::auth::SessionValidator for CognitoSessionValidator {
      async fn validate(&self, _pool: &sqlx::PgPool, _headers: &http::HeaderMap) -> Result<String, context::auth::AuthError> {
          Err(context::auth::AuthError::Unauthenticated) // dead code: use_cognito_sessions()
                                                          // requires Edition::Cloud, never set here
      }
      fn method(&self) -> &'static str { "cognito" }
  }
  ```

  `ha.rs`:

  ```rust
  pub fn check_ha_entitlement(_redis_host: Option<&str>, _entitled: bool) -> anyhow::Result<()> { Ok(()) }
  // Startup no longer refuses on a stray REDIS_HOST — the *reason* it refused (licensing) is
  // gone. It still refuses via redis_*_store below, just with a clearer message. NOT a
  // posture regression: a REDIS_HOST-configured box still fails to start in Phase 0, same
  // as before, only the failure now happens one step later with an accurate message instead
  // of an "Enterprise license" one that no longer makes sense.
  pub async fn redis_cache_store() -> anyhow::Result<std::sync::Arc<dyn cache::CacheStore>> {
      anyhow::bail!("Redis HA is not supported in this build; leave REDIS_HOST unset")
  }
  pub async fn redis_approval_store() -> anyhow::Result<std::sync::Arc<dyn approval::ApprovalStore>> {
      anyhow::bail!("Redis HA is not supported in this build; leave REDIS_HOST unset")
  }
  ```

  `kms_crypto.rs` — drop the `aws-sdk-kms` field type (nothing outside ee reads the `client` field per rust-seams; only `from_env()`/the trait impl are called):

  ```rust
  pub struct KmsEnvelopeCrypto;
  impl KmsEnvelopeCrypto { pub async fn from_env() -> Self { Self } } // infallible, matches wiring.rs
  #[async_trait::async_trait]
  impl crypto::EnvelopeCrypto for KmsEnvelopeCrypto {
      async fn decrypt(&self, _parts: &[&str]) -> anyhow::Result<String> {
          anyhow::bail!("KMS envelope encryption is not supported in this build; set SECRET_ENCRYPTION_KEY")
      }
      async fn encrypt(&self, _plaintext: &str) -> anyhow::Result<String> {
          anyhow::bail!("KMS envelope encryption is not supported in this build; set SECRET_ENCRYPTION_KEY")
      }
  }
  ```

  Delete `packages/api/src/ee/kms-envelope.fixture.json`'s `include_str!` reference (drop with the file) — WP3 deletes that JSON fixture as part of its own `ee` root wipe; no cross-WP coordination needed since each side just stops referencing it.

  `org_routes.rs`:

  ```rust
  pub fn mount(router: axum::Router<context::GatewayState>) -> axum::Router<context::GatewayState> { router }
  // GET /v1/org/approvals/pending 404s via axum's default fallback until Phase 1 adds it for
  // real. Safe because unlicensed.test.ts (which pinned the old 403 body on this path) is
  // deleted in this phase — see test triage.
  ```

  `platform_llm.rs`:

  ```rust
  pub const PLATFORM_SECRET_ID: &str = "platform:anthropic"; // still referenced by response::budget_exceeded
  pub fn configured_for_host(_hostname: &str) -> bool { false }
  pub fn pool_has_llm_credential(_secrets: &[db::SecretRow]) -> bool { false }
  pub async fn platform_credential(_pool: &sqlx::PgPool, _org_id: &str, _hostname: &str, _pool_has_llm: bool, _entitled: bool) -> Option<(inject::InjectionRule, budget::BudgetBinding)> { None }
  ```

  `principals.rs` — **the security-critical one, see Risk 2**:

  ```rust
  pub async fn find_principal_set(pool: &sqlx::PgPool, workspace_id: &str, organization_id: &str) -> anyhow::Result<db::PrincipalSet> {
      // Direct-only mirror of policy-engine's free `find_direct_user_principals` twin
      // (loaders.rs:42) — NOT a call to it (ee must not depend on policy-engine in
      // production; dev-dependency only, per rust-seams §B.1). Same org-fenced,
      // active-member-only shape, group_ids always []. This exactly reproduces today's
      // UNLICENSED behaviour (direct grants only) — group-based inheritance is Phase 1's
      // KEEP work, not a Phase 0 regression to leave inert.
      let user_ids: Vec<String> = sqlx::query_scalar!(
          "SELECT DISTINCT wa.user_id FROM workspace_access wa
           JOIN organization_members om ON om.user_id = wa.user_id AND om.organization_id = $2
           WHERE wa.workspace_id = $1 AND om.status <> 'suspended' AND wa.user_id IS NOT NULL",
          workspace_id, organization_id,
      ).fetch_all(pool).await?;
      Ok(db::PrincipalSet { user_ids, group_ids: Vec::new() })
  }

  pub async fn load_available_apps(_pool: &sqlx::PgPool, _org_id: &str, _workspace_id: &str) -> db::AvailableApps {
      db::AvailableApps::default() // { restricted: false, providers: [] } — TRIM per plan.md:
      // "loader can return unrestricted until the admin page ships" (Phase 2/3).
  }

  #[must_use]
  pub fn app_availability_block(host: &str, path: &str, available: &db::AvailableApps) -> Option<String> {
      // KEEP for real (plan.md: "Keep the pure app_availability_block") — pure, no I/O, cheap.
      // With load_available_apps always returning restricted:false this is always None today,
      // but implement the real strip-port/lowercase/provider-lookup logic per rust-seams §A.3
      // so Phase 2/3 only has to flip the loader, not touch this function.
      if !available.restricted { return None; }
      let host = common::util::strip_port(host).to_lowercase();
      let provider = apps::provider_for_host_and_path(&host, path)?;
      (!available.providers.iter().any(|p| p == &provider)).then_some(provider)
  }
  ```

  `granular_access.rs` — **the other security-critical one, see Risk 3**:

  ```rust
  #[derive(Debug)]
  pub struct Denial { pub reason: String, pub allowed: Vec<String>, pub rule_name: &'static str }

  pub fn needs_request_body(_policy: Option<&serde_json::Value>, _host: &str, _method: &str, _path: &str) -> bool { false }
  pub fn enforce_request(_policy: Option<&serde_json::Value>, _host: &str, _path: &str, _headers: &hyper::HeaderMap, _body: Option<&[u8]>) -> Option<Denial> { None }
  // Both DROP for real: the request-layer guards (Dropbox header/body inspection) are a
  // Phase 1 KEEP item; nothing in Phase 0 configures a granular-access policy with a request
  // guard yet (the web UI to create one doesn't exist until Phase 3), so False/None exactly
  // matches "no guard is active," not a regression.

  pub fn denies_everything(policy: Option<&serde_json::Value>) -> bool {
      // REAL, minimal: true iff policy is an object whose "repositories" or "folders" key
      // holds an empty array. Pure, ~6 lines, required by inject_select.rs's pinned test.
      let Some(obj) = policy.and_then(|v| v.as_object()) else { return false; };
      ["repositories", "folders"].iter().any(|axis| {
          obj.get(*axis).and_then(|v| v.as_array()).is_some_and(|a| a.is_empty())
      })
  }

  pub fn intersect_policies(a: Option<&serde_json::Value>, b: Option<&serde_json::Value>) -> Option<serde_json::Value> {
      // REAL, minimal, EXACT-MATCH ONLY (no prefix containment — that's Phase 1's
      // ResourceAxis-based rewrite, pinned only by the e2e resource-boundary.test.ts, which
      // is NOT a Phase 0 gate). This satisfies inject_select.rs's two in-crate unit tests,
      // which only exercise the disjoint-same-axis and one-sided-null cases.
      use std::collections::BTreeSet;
      match (a, b) {
          (None, None) => None,
          (Some(x), None) => Some(x.clone()),
          (None, Some(y)) => Some(y.clone()),
          (Some(x), Some(y)) => {
              let (Some(xo), Some(yo)) = (x.as_object(), y.as_object()) else {
                  return Some(if x.is_object() { x.clone() } else { y.clone() });
              };
              for axis in ["repositories", "folders"] {
                  let xa = xo.get(axis).and_then(|v| v.as_array());
                  let ya = yo.get(axis).and_then(|v| v.as_array());
                  match (xa, ya) {
                      (Some(xv), Some(yv)) => {
                          let xs: BTreeSet<&str> = xv.iter().filter_map(|v| v.as_str()).collect();
                          let ys: BTreeSet<&str> = yv.iter().filter_map(|v| v.as_str()).collect();
                          let inter: Vec<&str> = xs.intersection(&ys).copied().collect();
                          return Some(serde_json::json!({ axis: inter }));
                      }
                      (Some(_), None) => return Some(x.clone()),
                      (None, Some(_)) => return Some(y.clone()),
                      (None, None) => continue,
                  }
              }
              None
          }
      }
  }

  pub fn has_request_guard(_provider: &str) -> bool { false }
  pub fn has_token_scoper(_cred_type: &str) -> bool { false }
  pub async fn scope_token(_cred_type: &str, _creds: &serde_json::Value, _policy: Option<&serde_json::Value>) -> Option<anyhow::Result<(String, i64)>> { None }
  ```

  `rbac.rs`:

  ```rust
  pub struct RbacRoleResolver;
  #[async_trait::async_trait]
  impl context::auth::RoleResolver for RbacRoleResolver {
      async fn user_is_org_admin(&self, _pool: &sqlx::PgPool, _user_id: &str, _organization_id: &str) -> anyhow::Result<bool> { Ok(true) }
      async fn user_can_manage_workspace(&self, _pool: &sqlx::PgPool, _user_id: &str, _workspace_id: &str) -> anyhow::Result<bool> { Ok(true) }
  }
  // Proven equivalent to "no resolver installed" (see Executive Summary #2) — this is the
  // ONLY item in this crate where Ok(true)-always is verified-safe rather than a real check.
  ```

  `response.rs` — **REAL, verbatim wire shapes** (task explicitly calls these "tiny and Apache-shaped" — implement fully, do not stub):

  ```rust
  // All 5 return Response<context::ForwardResponseBody>, JSON, content-type: application/json,
  // x-should-retry: false. Copy exact bodies from rust-seams §A.7:
  pub fn quota_exceeded(limit: u64, org_id: Option<&str>) -> Response<ForwardBody> { /* 429 {error:"quota_exceeded", message, limit, upgrade_url} */ }
  pub fn budget_exceeded(binding: &budget::BudgetBinding, workspace_id: Option<&str>) -> Response<ForwardBody> { /* 403; error = "trial_credit_exhausted" iff binding.secret_id == platform_llm::PLATFORM_SECRET_ID else "budget_exceeded"; fields message, limit_usd, period, add_key_url = "{dashboard}/w/{ws}/connections/llms" */ }
  pub fn app_unavailable(provider: &str, method: &str, path: &str, host: &str) -> Response<ForwardBody> { /* 403 {error:"app_unavailable", message, provider, method, host: strip_port(host), path} */ }
  pub fn forbidden_resource(reason: &str, allowed: &[String]) -> Response<ForwardBody> { /* 403 {error:"resource_access_denied", message:"This agent is restricted to: …", allowed, detail: reason} */ }
  pub fn forbidden_empty_scope() -> Response<ForwardBody> { /* 403 {error:"resource_access_denied", message contains "do not overlap", allowed: [], detail:"empty resource scope"} */ }
  ```

  (These are dead-reachable today only via the granular_access/budget paths that are otherwise all-None/empty in Phase 0, except `forbidden_empty_scope`/`forbidden_resource` are NOT reachable since `enforce_request`/`denies_everything`'s callers currently never trigger — but implement them for real anyway since Phase 1 needs zero further changes here.)

- `apps/gateway/crates/ee/ee/Cargo.toml` — trim to: `anyhow, async-trait, axum, bytes, futures-util, http, http-body-util, hyper, serde, serde_json, sqlx` (workspace deps) + path deps `apps, cache, common, context, crypto, db, inject, telemetry` (drop `approval`, `policy`, `shutdown` if nothing in the new files needs them — verify at compile time; `approval` is needed for `ApprovalStore` trait bound in `redis_approval_store`'s return type). **Drop**: `aws-config, aws-sdk-kms, base64, jsonwebtoken, percent-encoding, redis, reqwest, ring, time`. **Drop the `[dev-dependencies]` `policy-engine` back-edge** (no parity tests exist in Phase 0's stub; add back in Phase 1 when the real CTE parity tests land). `license = "Apache-2.0"`.
- `apps/gateway/crates/ee/ee/src/*` — no `#[cfg(test)]` modules required for Phase 0 (the crate has zero business logic worth unit-testing beyond what `inject_select.rs`'s external tests already cover); optional: add 2-3 trivial `#[test]`s for `intersect_policies`/`denies_everything` if the reviewing agent wants in-crate coverage, not required for the gate.
- Regenerate `Cargo.lock` via `cargo build` (the gateway Dockerfile builds `--locked`, so this must be committed in sync).

### WP3 — `packages/api/src/ee` stubs + entitlement (L — the largest package, see Risk 1) (~2-2.5 days)

**WP3a — Truthful-minimal core (cannot be a null stub, product-breaking otherwise):**

| File                                                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/api/src/ee/services/authorization-service.ts`      | `OrgRole` type (`"owner" \| "admin" \| "member"`), `getUserRole(userId, organizationId)` → real `organization_members` read (`role` where `status <> 'suspended'`, else `null`); `requireRole(userId, organizationId, minimumRole)` → `getUserRole` + compare against `ROLE_HIERARCHY` (reuse the free constant from `providers/types.ts`), throw `ServiceError("FORBIDDEN", …)` on insufficient role; `canManageAllWorkspaces(role)` → `role === "owner" \|\| role === "admin"`; `hasWorkspaceAccessBinding(userId, workspaceId)` → real `workspace_access` direct-row existence check (no group traversal — TRIM, matches the Rust `find_principal_set` symmetry); `canAccessWorkspace(userId, workspaceId)` → org-admin OR direct binding; `canManageWorkspace(userId, workspaceId)` → same predicate as `canAccessWorkspace` in Phase 0 (Phase 2 can split view-vs-manage later); `eeWorkspaceAccessChecker: WorkspaceAccessChecker` → `{ canAccessWorkspaceAsUser: (userId, ref) => canAccessWorkspace(userId, ref.id), userIsOrgAdmin: (userId, orgId) => getUserRole(userId, orgId).then(r => r === "owner" \|\| r === "admin") }`. |
| `packages/api/src/ee/services/workspace-service.ts`          | `WorkspaceOwner`, `WorkspaceListItem`, `UserOrgWithWorkspaces` types (copy shapes from ts-seams §A.5/A.6 verbatim); `ensureUserDefaultOrgAndWorkspace(userId, userEmail)` → real: create-or-find the user's default org + workspace using the FREE `services/organization-service.ts` helpers (`bootstrap`/`ensure`/`slugify`/`activeMembershipWhere` already exist there per ts-seams §H) plus a direct `Workspace` create; `listWorkspaces(userId, organizationId?, role?)` → real Prisma query (workspaces the user can see = owns/has direct access to, or all if org-admin — reuse `canAccessWorkspace`); `createWorkspace(userId, userEmail, rawName, organizationId)` → real create (slugify name, no cap — Decision 2: multi-org has no cap, no `MAX_ORGS_PER_USER`); `getUserOrgsWithWorkspaces`, `listOrgWorkspacesForUser`, `getWorkspaceById`, `createOrgWorkspace`, `updateOrgWorkspace`, `deleteOrgWorkspace` → straightforward CRUD against the `Workspace` model, gated by `authorization-service`'s predicates, no quota/plan checks.                                                                                     |
| `packages/api/src/ee/services/workspace-management-guard.ts` | `requireWorkspaceManagement(authCtx, targetId)` → `canManageWorkspace(authCtx.userId, targetId)` else throw `ServiceError("FORBIDDEN", …)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/api/src/ee/services/quota-service.ts`              | `getWorkspaceQuota(organizationId)` → `{ current: <real workspace count via a trivial count() query>, limit: Number.POSITIVE_INFINITY, plan: "enterprise" }`; `assertCanCreateWorkspace(organizationId)` → no-op, never throws (Decision 2: no cap).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**WP3b — Real-but-tiny (pure, Apache-shaped, no reason to fake):**
| File | Behavior |
|---|---|
| `packages/api/src/ee/billing/plan-features.ts` | Keep `PremiumFeature` union type verbatim; `isPremiumFeature` real type-guard; `requiredPlanFor(_)` → `"free"` (moot once `isPlanAtLeast` is always true, but keep the real function shape). |
| `packages/api/src/ee/billing/plans.ts` | `Plan`, `SubscriptionStatus` types kept verbatim; `normalizePlan(_)` → constant `"enterprise"`; `isPlanAtLeast(_plan, _min)` → constant `true`; `getPlanConfig(_plan)` → `{ limits: { auditLogDays: 365, /* other limit fields → Number.MAX_SAFE_INTEGER, none are read by free code today per ts-seams */ } }` (365-day retention chosen as a sane non-infinite default rather than `Infinity`, which could break date-math call sites; document the constant with a comment pointing here). |

**WP3c — NULL-STUB (cloud-only / permanently-dropped features; matches today's already-inert unlicensed behavior 1:1):**
| Specifier | Stub |
|---|---|
| `./ee` (`index.ts`) | `registerEeRoutes(_app) {}` — mounts nothing. Every web hook that calls an ee-mounted route by URL (§D.3 client modules) now gets Hono's default 404 until Phase 2 mounts the real routers — acceptable, no free UI depends on these routes existing yet since the pages that call them (Groups, Domains, SSO, Members directory, Workspace access, App availability, Dropbox folders) are themselves TRIM/DROP stubs in WP4. |
| `./ee/scim` | `createScimApp()` → a `Hono` app that 404s every route. |
| `./ee/auth/session-hooks` | `eeSessionHooks` → re-export the FREE `onpremSessionHooks` object directly (plan.md's explicit instruction) — `import { onpremSessionHooks } from "../lib/onprem-session-hooks"; export const eeSessionHooks = onpremSessionHooks;`. |
| `./ee/auth/cognito-identity` | `parseCognitoIdentityClaims(_payload)` → `{ identityProviders: [], federatedProvider: null, emailVerified: false }`; keep `CognitoIdentityClaims` type. (Cloud-only, dead in practice since `IS_CLOUD` is never true in this fork — leaving a trivial stub is lower-risk than also editing `apps/api-server/src/cognito-session-provider.ts`.) |
| `./ee/billing/aws-marketplace/metering-job` | `startAwsMarketplaceMeteringJob() { return null; }`. |
| `./ee/sso/sso-enforcement` | `enforceSsoSession` → `async () => null`. |
| `./ee/sso/jit-service` | `ensureSsoJitMembership` → `async () => {}`. |
| `./ee/sso/sso-trust` | `findSsoOrgForIdentity` → `async () => null`. |
| `./ee/notifications/discord` | `notifyDiscord` → `() => {}`. |
| `kms-crypto.ts` | `cryptoService: CryptoService` → `{ encrypt: async () => { throw new Error("KMS crypto not supported in this build; set SECRET_ENCRYPTION_KEY"); }, decrypt: same }`. |
| `clients/redis-client.ts` | `hasRedisConfigured() → false`; `getRedis()` → `throw new Error("Redis not supported in this build")`. |
| `event-bus/redis-event-bus.ts` | `createRedisEventBus` → `throw new Error(...)` (never called since `hasRedisConfigured()` is always false). |
| `apps/app-availability-provider.ts` | `appAvailability: AppAvailabilityProvider` → `{ getAvailableProviders: async () => null }` (= all apps available, matches TRIM). |
| `middleware/rate-limit.ts` | `rateLimit(_opts)` → a Hono middleware that's a no-op passthrough; `clientIpKey` → real trivial implementation (pure, keep it). |
| `hooks/connection-hooks.ts`, `hooks/resource-hooks.ts`, `hooks/team-hooks.ts` | `eeConnectionHooks`/`eeResourceHooks` → no-op pairs (mirrors the free onprem default exactly — these slots are cloud-only per §C table); `eeTeamHooks` → **exception**: plan.md keeps this one active on onprem+entitled too (`initTeamHooks(eeTeamHooks)` when entitled — now always). Stub as the free no-op pair too for Phase 0 (seat-cap/provision-sweep is a cloud/billing concept with no Phase-0 equivalent); this matches unlicensed-onprem's existing no-op behavior exactly, so no regression. |
| `hooks/rule-action-gate.ts` | `eeRuleActionGate` → `{ assertAllowed: async () => {} }` (always-allow; matches unlicensed onprem's `onpremRuleActionGate`'s "identity_directory_group" gate being the ONLY thing checked there — since groups aren't built yet in Phase 0 anyway, always-allow is equivalent). |
| `granular-access/index.ts` | `eePolicyValidator: PolicyValidator` → `{ validate: async () => {} }` (always-allow; the free `onpremPolicyValidator` twin already does real shape validation without entitlement checks — consider re-exporting that instead of a bare no-op, since it's free and already correct: `export { onpremPolicyValidator as eePolicyValidator } from "../services/policy-onprem-validator";` — **prefer this over a no-op**, it's zero extra work and strictly safer). |
| `granular-access/shape.ts` | `validatePolicyShape` → delegate to the same free shape-check logic if reasonably extractable, else a permissive `async () => {}` no-op. |
| `services/new-org-policy-seeder.ts` | `eeNewOrgPolicySeeder` → re-export the FREE `onpremNewWorkspacePolicySeeder` (`services/policy-onprem-seeder.ts`) directly — same reasoning as session-hooks. |
| `services/platform-llm.ts` | `eePlatformLlm: PlatformLlmProvider` → `{ trialCreditApplies: () => false }`. |
| `ssh/kms-ssh-ca.ts` | `kmsSshCa` → `null`. |
| `services/team-service.ts` | `TeamMember` type kept; `listMembers`, `removeMember`, `findDeletablePersonalWorkspaces` → **these ARE exercised by `org-departure-free.test.ts`, which is KEPT** (see test triage) — implement for real (simple `organization_members`/`Workspace` queries), not a stub. This is a second WP3a-class item, small (a few dozen lines), flagged here rather than above because it's one file not three. |
| `services/authorization-service.ts` extra: `getUserRole` re-export used by team-service — already covered above. |

Delete `packages/api/src/ee/kms-envelope.fixture.json`, `packages/api/src/ee/kms-crypto.contract.test.ts` (tests real KMS↔Rust envelope compat — meaningless once both sides bail; delete, don't rewrite).

**WP3d — Entitlement + route/type wiring:**

- `packages/api/src/lib/entitlements.ts` — see WP1 1c (isEntitled → true). Assign either WP1 or WP3; listing here too since WP3 is the one that needs to verify all the downstream callers listed in §F still compile with a constant-true entitlement.
- Root `package.json` / `packages/api/package.json` — see WP1 1b (`test:licensing` removal); coordinate with WP1 so it's a single diff, not two competing edits to the same script line.

### WP4 — `apps/web/src/ee` stubs, route wrappers, bring-over prose (M, ~1.5-2 days; depends on WP3's exported types for the handful of components that import ee-side TS types like `TeamMember`, `OrgRole`, `WorkspaceOwner`)

**WP4a — TRUTHFUL-MINIMAL / KEEP-thin (plan.md's web scope table marks these KEEP, and they're small enough to do for real now rather than stub-then-redo in Phase 3):**
| Module | Behavior |
|---|---|
| `apps/web/src/ee/team/actions.ts` | `getUserOrgRole` → calls the real `@onecli/api/ee/services/authorization-service`'s `getUserRole` (already real per WP3a) — thin re-export/wrapper, no stubbing needed. `getOrgSubscriptionStatus` → constant `async () => "active"` (billing is DROP; team-page.tsx only uses this to decide whether to show `TeamUpgradeBanner`, which is itself null-stubbed below, so this value is inert either way — keep it truthful-shaped rather than throwing). |
| `apps/web/src/ee/team/_components/manage-access-dialog.tsx` | TRIM to role-only per plan.md — drop the `currentSsoExempt`/`roleManagedByIdp` UI entirely (SSO is DROP forever), keep the role-change form wired to the real `changeTeamMemberRole` action. |
| `apps/web/src/lib/granular-access/index.ts` re-export target `apps/web/src/ee/granular-access/index.ts` | Keep `granularAccessConfigs: Map` real, with the GitHub picker (`github-app/policy-dialog-content`) kept per plan.md ("keep the `granularAccessConfigs` export and the GitHub picker"); Dropbox's `PolicyDialogContent` can be a placeholder ("folder picker coming later") since the Dropbox request-guard itself is a Phase 1 Rust item. |

**WP4b — NULL-STUB (billing/quota/SSO/AWS-marketplace/reviewer — all permanently DROP, all already effectively inert on unlicensed onprem today so a null stub is a like-for-like match):**
All of §A.5/§B's `billing/*`, `sso/*` (except the trust/enforcement/jit already covered by WP3), `aws-marketplace/*`, `review/*` symbols get null/no-op stand-ins exactly as plan.md's web table specifies:

- `getResourceQuota` → `async () => ({ current: 0, limit: Infinity, plan: "enterprise", atLimit: false, organizationId })`.
- `QuotaLimitDialog`, `OverQuotaBanner`, `SidebarQuota`, `PlanBadge`, `TeamUpgradeBanner`, `PlanPaywallDialog` → `() => null`.
- `usePlanUsage` → `() => null`.
- `UpgradeToTeamButton` → `() => null` (or omit its render call site — it's a free component embedding an ee one; leave the free wrapper untouched, just null the ee side).
- `hasPendingMarketplaceToken`, `completeMarketplaceRegistration` → stubs that make the AWS-marketplace routes 404/no-op (they're gated by `IS_CLOUD`/`notFound()` in the free wrapper already, so the ee body barely matters — keep it trivial).
- `ReviewerLoginPage` default export → simple "not available" page or reuse the redirect pattern.

**WP4c — Route wrappers rendering `EnterpriseLockedCard` (5 files, §A.4) — the "Coming in a later phase" question:**

- Introduce a new free component `apps/web/src/lib/components/coming-soon-card.tsx` (Apache, same props shape as `EnterpriseLockedCardProps { feature, description }` for minimal wrapper churn, but copy rewritten: no lock icon/"Enterprise" pill/pricing CTA — plain "Coming in a later phase" message, optionally a link to `docs/upstream-sync/v2-migration/plan.md`'s public roadmap if one exists, else no CTA). Do **not** try to find/reuse a generic `EmptyState` — grepped, the only one in the tree is scoped to a single agent-detail page, not reusable.
- `apps/web/src/app/.../groups/page.tsx`, `.../settings/app-availability/page.tsx`, `.../settings/domains/page.tsx` — these are legitimately "coming later" (Phase 2/3 KEEP items). Leave the wrapper's `isEntitled() ? <Page/> : <Locked/>` structure **untouched** (zero free-file edit, per Principle 2) — since `isEntitled()` is now always true, the wrapper always renders the ee default export; make the ee stub pages (`groups-page.tsx`, `app-availability-page.tsx`, `org-domains-page.tsx`) themselves render `<ComingSoonCard feature="groups" description="..."/>` etc. as their entire body in Phase 0.
- `apps/web/src/app/.../settings/sso/page.tsx` and `apps/web/src/app/auth/login/sso/page.tsx` and `apps/web/src/app/claim/page.tsx` — these are **permanently dropped**, not "coming later." Recommend a **small, documented free-file edit**: change these 3 wrappers to redirect unconditionally (sso settings → org settings general; sso login → `/auth/login`; claim → `/`) instead of rendering an ee stub at all, since "coming in a later phase" would be a false promise for features with no place on the roadmap. This is the one deliberate deviation from "zero free-file edits" in WP4 — document it in the phase's free-file-edit list per Principle 6.
- `apps/web/src/ee/account/create-org-page.tsx` — plan.md Decision 2 says create-org ships with no cap; this is real work belonging to Phase 3 per plan.md's phase table, so for Phase 0 render `ComingSoonCard` here too (create-org today is reachable but the KEEP UI doesn't exist yet).

**WP4d — Types-only re-exports** (zero runtime behavior, just keep the type surface compiling): `OrgRole`, `WorkspaceOwner`, `WorkspaceListItem`, `TeamMember`, `Plan`, `PremiumFeature`, `ResourceQuota`, `PlanUsage` — all already covered by their owning module's stub above; no separate action.

---

## 2. Per-symbol stub tables

See WP2/WP3/WP4 above for the full symbol|signature|behavior|rationale tables — they're written inline with the file lists so the dev agent doesn't have to cross-reference two documents while editing. Summary of the categorization used throughout:

- **TRUTHFUL-REAL**: implemented correctly now because the alternative breaks the product or a security invariant (workspace-service, authorization-service, workspace-management-guard, team-service's free-tested methods, `find_principal_set`, `intersect_policies`, `denies_everything`, `RbacRoleResolver`, `response::*`, `app_availability_block`).
- **TRUTHFUL-MINIMAL constant**: a real-shaped value that happens to always be the same (e.g. `normalizePlan → "enterprise"`, `isPlanAtLeast → true`) because Decision 2/entitlement-always-on makes the variable dimension moot.
- **NULL-STUB**: a null/no-op/false/None that is **provably equivalent** to today's unlicensed-onprem default (verified per-symbol above, not assumed) — cloud-only, SSO, billing, AWS Marketplace, platform LLM, KMS, Cognito, Redis HA.

---

## 3. Test triage table

### Deleted wholesale (inside the three ee roots — everything, source and tests, per Principle 2's "delete the contents")

All `*.test.ts(x)` under `packages/api/src/ee/**` (61 files), `apps/web/src/ee/**` (6 files), and every `#[test]` inside `apps/gateway/crates/ee/ee/src/**` (13 files) — gone with their parent source files. No individual triage needed; WP2/3/4 add back a handful of new tests only where noted above (none required for the gate).

### `packages/api/src/licensing/**` (WP1, delete wholesale)

| File                                                        | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ee-boundary.ts`, `ee-boundary.test.ts` (+ `__snapshots__`) | **delete**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The whole licensed-roots/crossing-count/snapshot machinery is meaningless once `ee/` is Apache; nothing replaces it.                                                                                                                       |
| `ee-mount-lock.test.ts`                                     | **delete**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Asserted every ee-mounted route 403/404/410s when unlicensed — no more unlicensed state to assert.                                                                                                                                         |
| `enterprise-lock.test.ts`                                   | **delete**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Feature-by-feature entitlement probe over `ENTERPRISE_FEATURES` — moot once entitled() is always true; also the pointer to `ha_entitlement_check_is_table_driven` in `ha.rs` goes with it (confirms WP2 need not preserve that test name). |
| `org-departure-free.test.ts`                                | **delete file, but port its 2-3 assertions into a new free-tree test** (e.g. `packages/api/src/ee/services/team-service.test.ts` is gone too since it's inside ee/, so land the assertions as `packages/api/src/services/team-departure.test.ts` or similar, outside the ee root) — the _behavior_ it pins (unlicensed leave-org succeeds) is now just "leave-org succeeds, period," worth keeping as a regression guard on WP3's real `removeMember`/`listMembers`/`findDeletablePersonalWorkspaces`. |
| `org-credentials-free.test.ts`, `ssh-keys-free.test.ts`     | **delete**, no port needed — these assert free code never imports `ee/` for secrets/connections/apps/ssh, which stays true trivially once there's no entitlement gate to test against; if desired, a lighter free-standing smoke test can replace it but it's not required for the gate.                                                                                                                                                                                                               |
| `third-party-notices.test.ts`                               | **keep, move out of `licensing/`** to e.g. `packages/api/src/lib/third-party-notices.test.ts` — unrelated to ee/licensing, just co-located historically; update its import path if it reads `NOTICE` by relative path.                                                                                                                                                                                                                                                                                 |
| `scripts/cloud-boundary.test.mjs`                           | **delete**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Already a silent no-op in this repo (guarded on `package.json name === "onecli-cloud"`); brief listed it, confirmed harmless either way but deleting matches plan.md's explicit instruction.                                               |

### `.onprem.test.tsx` / `.cloud.test.tsx` pairs and `initEntitlementForTests(false)` callers (grepped exhaustively)

| File                                                                                                                                                                  | Verdict                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api/src/lib/entitlements.test.ts`                                                                                                                           | **rewrite**                                                                                                                       | Tests `isEntitled()`'s env-parsing branches — now a constant, rewrite to assert `isEntitled() === true` unconditionally (and that `ENTERPRISE_FEATURES`/`isEnterpriseFeature` still export correctly).                                                                                                                                                              |
| `packages/api/src/routes/instance.test.ts`                                                                                                                            | **rewrite**                                                                                                                       | Asserts `entitled` field in `GET /v1/instance` payload for both states — now only the true-state assertion is meaningful; delete the false-state case.                                                                                                                                                                                                              |
| `packages/api/src/routes/instance-ssh.test.ts`                                                                                                                        | **check & likely rewrite**                                                                                                        | Same shape, verify at implementation time.                                                                                                                                                                                                                                                                                                                          |
| `packages/api/src/ee/sso/sso-trust.test.ts`                                                                                                                           | **delete**                                                                                                                        | Inside `ee/`, gone with the root anyway; listed here only because it also appeared in the `initEntitlementForTests(false)` grep.                                                                                                                                                                                                                                    |
| `apps/web/src/app/auth/login/sso/sso-login-page.onprem.test.tsx`                                                                                                      | **delete**                                                                                                                        | Tests the redirect-when-unentitled arm; per WP4c the SSO route now redirects unconditionally, so fold this into a single `sso-login-page.test.tsx` asserting "always redirects."                                                                                                                                                                                    |
| `apps/web/src/app/(dashboard)/org/[orgId]/(admin)/enterprise-wrappers.onprem.test.tsx`                                                                                | **rewrite**                                                                                                                       | Tests all 5 `EnterpriseLockedCard` wrappers' unentitled arm at once — rewrite to assert the entitled arm renders the WP4c stub content (`ComingSoonCard` for groups/app-availability/domains, redirect for sso/claim).                                                                                                                                              |
| `apps/web/src/app/claim/claim-page.onprem.test.tsx`                                                                                                                   | **delete**, fold into claim-page's single remaining test (redirect).                                                              |
| `apps/web/src/ee/groups/groups-page.onprem.test.tsx`, `apps/web/src/ee/app-availability/app-availability-page.onprem.test.tsx`                                        | **delete**                                                                                                                        | Inside `ee/`, gone with the root. Their `.cloud.test.tsx` twins are also gone (same reason) — WP4 adds one new trivial test per stub page asserting it renders `ComingSoonCard`, not required for the gate.                                                                                                                                                         |
| `apps/web/src/lib/dashboard/dashboard-sidebar.onprem.test.tsx`, `sidebar-version.onprem.test.tsx`, `sidebar-version.cloud.test.tsx`, `sidebar-version.baked.test.tsx` | **rewrite/consolidate**                                                                                                           | These test nav/version-banner rendering differences by entitlement/edition — since entitlement is now constant, collapse the onprem+entitled-false cases into the single remaining onprem+entitled-true case; keep the cloud-edition cases (edition itself still varies).                                                                                           |
| `apps/web/src/lib/nav-config.cloud.test.ts`, `nav-config.onprem.test.ts`                                                                                              | **rewrite**                                                                                                                       | `nav-config.ts`'s `entitled?: boolean` option — audit whether any nav entry differs by entitlement now that it's always true; likely collapses the onprem-unentitled case away, keep the rest.                                                                                                                                                                      |
| `apps/web/src/lib/onboarding/onboarding-layout.cloud.test.tsx`, `.onprem.test.tsx`                                                                                    | **check, likely mostly unaffected**                                                                                               | These vary primarily on `CAPS.billing`/`IS_CLOUD`, not entitlement directly — verify at implementation time whether either references `initEntitlementForTests`/`entitled:false`; if not, no change needed.                                                                                                                                                         |
| `apps/web/src/lib/user-plan.onprem.test.ts`                                                                                                                           | **rewrite**                                                                                                                       | `normalizePlan` is now a constant; simplify the test to assert the constant, drop the entitlement-varying cases.                                                                                                                                                                                                                                                    |
| `packages/api/src/middleware/auth/resolve.onprem.test.ts`                                                                                                             | **check**                                                                                                                         | In ts-seams §A.7's "test files that import ee" list — verify whether it depends on `getUserRole` returning `null` (old default) vs the new real value; likely needs updating to seed a real `organization_members` row instead of relying on the null-role fallback.                                                                                                |
| `apps/web/src/lib/team/join-page.onprem.test.tsx`                                                                                                                     | **check, likely unaffected** (edition-based, not entitlement-based — verify).                                                     |
| `packages/api/src/routes/unsubscribe.onprem.test.ts`                                                                                                                  | **likely unaffected** — `ResendBadEmail`/`ResendWebhook` models are free; verify no entitlement dependency, else trivial rewrite. |
| `apps/web/src/app/aws-marketplace/edition-gate.{cloud,onprem}.test.ts`                                                                                                | **delete or rewrite to assert always-404/never-cloud**                                                                            | AWS Marketplace is permanently dropped; these test the `IS_CLOUD` gate specifically (edition, not entitlement) — likely survive unchanged since `IS_CLOUD` itself isn't touched by Phase 0; verify.                                                                                                                                                                 |
| `packages/api/src/routes/org-apps.test.ts`, `org-policy.test.ts`, `workspaces.test.ts`                                                                                | **rewrite**                                                                                                                       | ts-seams §A.7's "test files that import ee" — these exercise the free routers that call the now-real WP3a services; update fixtures/expectations to match the real (not null) `getUserRole`/`workspace-service` behavior. `workspaces.test.ts` is the one that makes WP3a's "must be real" finding concrete — it cannot pass against a null-stub workspace-service. |
| `packages/api/src/services/policy-onprem-validator.test.ts`                                                                                                           | **rewrite**                                                                                                                       | Update for the `eePolicyValidator` re-export decision (WP3c: prefer re-exporting the free validator over a bare no-op).                                                                                                                                                                                                                                             |

### Rust in-crate tests (part of `cargo test --workspace`, hard Phase 0 gate)

| Test                                                                                                                                                                                        | Verdict                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy-engine/src/inject_select.rs::a_workspace_pick_outside_the_org_boundary_denies_everything` + its `folders`-axis neighbours                                                           | **keep, must pass** against WP2's real `intersect_policies`/`denies_everything` — this is the whole reason those two functions aren't naive stubs.                                                    |
| `policy-engine/src/enforce.rs::entitlement_tests::principal_query_signal_is_entitlement_aware`                                                                                              | **keep, unaffected** (pure free-code test, doesn't call ee).                                                                                                                                          |
| `policy-engine/src/corpus_test.rs` (group-`g1` block rule test)                                                                                                                             | **keep, unaffected** (constructs `PrincipalSet` directly, doesn't call `find_principal_set`).                                                                                                         |
| `proxy/src/hooks.rs` `call_limit_for_plan` table test                                                                                                                                       | **keep, unaffected**.                                                                                                                                                                                 |
| `onecli-gateway/src/main.rs` `check_cloud_startup_env` table test                                                                                                                           | **keep, unaffected**.                                                                                                                                                                                 |
| Any `#[test]` inside the OLD `ha.rs`/`rbac.rs`/`binding.rs`/`resolve.rs` (`entitlement_pg_tests`, `parity_tests`, `workspace_access_recheck_tests`, `ha_entitlement_check_is_table_driven`) | **gone with the deleted files** — no replacement required in Phase 0 (the enterprise-lock.test.ts pointer to `ha_entitlement_check_is_table_driven` is also deleted, per rust-seams §G.3's own note). |

### Gateway e2e (`apps/gateway-e2e/tests/*.test.ts`)

| File                                                                                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unlicensed.test.ts`                                                                                                  | **delete**, per plan.md's explicit instruction and rust-seams §11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `platform-llm.test.ts`                                                                                                | **delete**, per the same instruction (Cloud-only scenarios, unreachable in an onprem-only fork).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `resource-boundary.test.ts`, `control.test.ts` (app-availability section), `policy.test.ts` (rule-identities section) | **not a Phase 0 gate** — these pin the FULL (prefix-containment / group-inheritance / app-availability-loader) behavior that WP2's Phase 0 stubs deliberately don't implement yet. Leave the files in place; expect them to fail until Phase 1 lands the real `granular_access`/`principals`/`rbac`. **Recommend marking their licensed-arm scenarios `.skip` with a `// Phase 1` comment** rather than deleting, so Phase 1 has a ready-made acceptance test. Do not count these toward Phase 0's "free-surface suites green" gate. |
| `session-cookie.test.ts`, `websocket.test.ts`, `approval.test.ts`                                                     | **keep, should already pass** — these don't depend on entitlement state; `approval.test.ts` will now exercise the free in-memory `ApprovalStore` (since Redis is optional/off per WP1's `env.ts` fix) rather than the Redis-backed one — verify its assertions aren't Redis-specific (BLPOP timing etc.); if they are, mark the Redis-specific assertions `.skip` with a "Redis dropped, decision 6" comment.                                                                                                                        |

---

## 4. Risks

**Risk 1 (highest) — "compile-only stub" is not achievable for `workspace-service`/`authorization-service`/`workspace-management-guard` without breaking the product.** Verified by reading `packages/api/src/routes/workspaces.ts` and `apps/web/src/lib/workspaces/actions.ts`: these call the ee services **unconditionally**, with no entitlement gate. A null/throwing stub here doesn't "keep free callers compiling," it makes workspace creation/listing fail for every user, which also fails `pnpm test` (`routes/workspaces.test.ts`). This plan resolves it by having WP3a ship a real, minimal (direct-membership-only, no groups, no quota) implementation — effectively pulling a slice of plan.md's Phase 2 ("authorization + workspace service ... Order: authorization + workspace service (everything free depends on them) → ...") forward into Phase 0. **This is the main reason Phase 0's true size is closer to the low end of "M" for WP3 rather than a pure "compile-only" pass**, and it modestly changes plan.md's "2-3 days" Phase 0 estimate (recommend informing Marco: realistic Phase 0 total is closer to 5-7 engineer-days across all 4 WPs run in parallel, dominated by WP3's ~2.5 days). **Alternative if Marco wants a strictly 2-3-day Phase 0:** null-stub these three modules anyway (`listWorkspaces → []`, `createWorkspace → throw "not yet implemented"`) and mark `routes/workspaces.test.ts` + the workspace server actions' tests `.skip` with a "Phase 2" tracking comment — but then the tree, while "buildable," is not usable for even manual smoke-testing until Phase 2 lands. Recommend the former; flagging both so this is Marco's call, not silently decided.

**Risk 2 — `ee::principals::find_principal_set` regression if naive.** Once `common::edition::entitled()` is hardcoded `true`, this function is called on **every** CONNECT with a non-agent identity (previously: only on a licensed onprem box, which today essentially never exists). A stub returning an empty `PrincipalSet` would silently revoke every direct-user grant that works today (upstream-unlicensed uses the free `find_direct_user_principals` twin, which finds direct grants). This plan's WP2 spec mirrors that free twin's direct-only query inside `ee` (without a production dependency on `policy-engine`, honoring the one-way dependency constraint) — verified **not weaker** than today's unlicensed posture (same direct-grant set, `group_ids` empty either way pre-Phase-1). Flag if any dev agent is tempted to "simplify" this to `Ok(PrincipalSet::default())` — that would be the regression this risk describes.

**Risk 3 — `ee::granular_access::{denies_everything, intersect_policies}` regression if naive.** Same mechanism: `entitled=true` activates `stamp_resource_scopes`'s `intersect_policies` call (`connect.rs:190-193`) on every connection with both an org boundary and a workspace-level policy, where today's unlicensed path always uses `session_policy = None` (fully unscoped, not intersected at all). The prompt's own strawman (`a.cloned().or(b.cloned())`) was flagged explicitly as wrong: it can produce a _more permissive_ result than either input side alone (e.g., returning the org boundary `{"repositories":["org/a"]}` unchanged when the workspace selection was actually `{"repositories":["org/z"]}` — a real credential-scope leak). WP2's minimal exact-match-only `intersect_policies` fixes this for the cases the in-crate unit tests pin; full prefix-containment semantics (`/clients` ⊇ `/clients/acme`) remain a Phase 1 item, correctly deferred since it's only pinned by the e2e suite (not a Phase 0 gate). **Do not ship the `a.cloned().or(b.cloned())` version under any time pressure** — it compiles and looks harmless but is the one line in this entire phase most likely to cause a real security incident if shipped.

**Risk 4 — `RbacRoleResolver::Ok(true)` looks unsafe but is proven equivalent.** Documented here so a future reviewer doesn't "fix" it into a real DB check under the mistaken belief it's a stub-shaped hole — see Executive Summary #2 for the code-level proof (`auth.rs:448-460`, `:551-562`). No action needed beyond keeping the comment in the source explaining why.

**Risk 5 — `apps/gateway-e2e/src/env.ts`'s `E2E_REDIS_HOST` requirement blocks CI entirely once Redis is dropped**, unless WP1's free-file edit lands. This is a hard blocker for the "gateway-e2e free-surface suites green" gate, not just a nice-to-have — flag prominently to whichever agent picks up WP1 first.

**Risk 6 — Install-domain ambiguity (Decision 0.C).** Shipping WP1 without touching `onecli.sh`/`app.onecli.sh`/support-email strings is safe (nothing breaks), but if left unaddressed long-term the install banners will point users at a domain the fork doesn't control. Not a Phase 0 blocker; flag for a follow-up decision, don't block the phase on it.

**Risk 7 — `eeTeamHooks`/`eeRuleActionGate`/connection/resource hooks as pure no-ops** are safe **only because they match today's already-inert unlicensed default** (verified per-symbol in WP3c) — this is a lower-risk category than Risks 2/3 but worth a single sentence in code review: if any of these ever gets "entitled"-gated logic added without checking this equivalence, the safety argument disappears.

---

## 5. Verification commands

Run from the worktree root (`/Users/marco/Projects/ai-agents/onecli/.claude/worktrees/v2-phase0`) unless noted:

```bash
# TypeScript / lint / format / scripts (WP1, WP3, WP4)
pnpm install
pnpm run check        # turbo lint + check-types + format:check + test:scripts (test:licensing removed per WP1)
pnpm test             # turbo run test — all vitest suites across packages/apps, per the triage table above

# Rust gateway (WP2) — run from apps/gateway
cd apps/gateway
cargo build --workspace
cargo test --workspace              # hard gate: includes inject_select.rs's two pinned tests (Risk 3)
cargo clippy --workspace --all-targets -D warnings
cargo doc --workspace -D warnings
cd -

# Gateway e2e (WP2/WP1) — needs native Postgres on localhost:5432 (per instructions: do NOT use Docker for this)
cd apps/gateway-e2e
# Redis must be OPTIONAL per WP1's env.ts fix — do not set E2E_REDIS_HOST to exercise the
# "no Redis" path; set it only to smoke-test the free in-memory-store fallback isn't silently
# broken. Required regardless of Redis:
export E2E_ADMIN_DATABASE_URL="postgres://<user>@localhost:5432/postgres"
export E2E_TEMPLATE_DB="onecli_gateway_e2e_template"   # migrated once, per README.md's setup steps
pnpm test -- session-cookie websocket approval          # "free-surface" suites — must be green
pnpm test -- --grep "unlicensed|resource-boundary|control|policy" # expect Phase-1-deferred licensed-arm
                                                                    # scenarios to be .skip'd, not failing
cd -

# Docker / compose sanity (WP1) — build-only check that the trimmed matrix + renamed images are coherent,
# does not require pushing to ghcr.io
docker compose -f docker/docker-compose.yml config >/dev/null   # validates image/env interpolation

# Full-tree smoke (manual, after all WPs land) — confirms Risk 1's resolution:
pnpm --filter @onecli/web dev &
pnpm --filter @onecli/api-server dev &
# sign up, confirm a default org + workspace is created (ensureUserDefaultOrgAndWorkspace),
# confirm GET /v1/workspaces lists it (WP3a's real listWorkspaces), confirm the org admin can
# see the Team page (WP3a's real getUserRole), confirm Groups/App-availability/Domains show
# "Coming in a later phase" (WP4c) rather than an "Enterprise license required" message.
```

---

### Critical files for implementation

- `apps/gateway/crates/ee/ee/src/{granular_access.rs,principals.rs,rbac.rs}` — the security-critical stubs (Risks 2-4); everything else in the Rust crate is low-risk by comparison.
- `packages/api/src/ee/services/{workspace-service.ts,authorization-service.ts,workspace-management-guard.ts}` — the "must be real, not a stub" core (Risk 1); the single biggest scope/estimate change from the original brief.
- `apps/gateway-e2e/src/env.ts` — the free-file edit that unblocks the whole gateway-e2e gate once Redis is dropped (Risk 5).
- `scripts/publish-workflow.test.mjs` — the one CI drift-guard test that genuinely needs a rewrite (the brief's other three listed test files need none, per Executive Summary #5).
- `docs/upstream-sync/v2-migration/plan.md` (already read, not edited by this plan) — the source of truth this plan implements; `CLAUDE.md` (WP1d) is the file that should end up describing the state this plan produces.

---

## Orchestrator vetting notes (2026-09-14)

Accepted as written, with these amendments. Where this section disagrees with the text above, this section wins.

1. **Risk 1 accepted.** WP3a ships a real, minimal `workspace-service`, `authorization-service`, and `workspace-management-guard` (direct membership only, no groups, no quotas). This pulls the first slice of Phase 2 forward; Phase 0 is re-estimated at 5–7 engineer-days across four parallel work packages.
2. **`intersect_policies` and `denies_everything` are implemented in full in Phase 0**, not exact-match-only. Both are pure functions with a complete decision table in `gateway-ee-behaviour.md` §1.3–§1.5 (axis normalization, symmetric containment for `folders`, sorted+deduped output, mismatched-axis deny-all sentinel, raw-entry read for `denies_everything`). Doing a partial version now and a full one in Phase 1 is wasted work and leaves a window where a nested-folder boundary is mis-composed. Unit tests must cover every row of those tables.
3. **`find_principal_set` in Phase 0 = direct users only**, mirroring the free twin's query (org-fenced, `status <> 'suspended'`), `group_ids` empty. Groups arrive in Phase 1. Must not depend on `policy-engine`.
4. **`RbacRoleResolver` returns `Ok(true)`** for both methods with a source comment citing `context/src/auth.rs` (resolver absent ⇒ recheck skipped). Phase 1 replaces it with the real queries.
5. **Decision 0.C (install domain, support email) stays open.** Leave `onecli.sh` / `app.onecli.sh` / `*@onecli.sh` strings untouched with a `TODO(fork-domain)` marker; Marco decides the replacement domain. Repo identity (`whybutter/onecli`, `ghcr.io/whybutter/onecli-*`) proceeds.
6. **Decision 0.A accepted:** runner, agent, ssh-terminator and channel-adapter images stay pointed at upstream's public images and are not built by our publish matrix.
7. **Clean-room rule applies to the dev agents.** They implement from `phase0-plan.md`, the seam inventories, and the behaviour specs. They do not open files under the three `ee/` roots of the upstream tree (which are deleted in WP1's first commit anyway). The planner read them to write this plan; that is the intended division.
8. **Sequencing:** WP1, WP2, WP3 start together in separate worktrees off `v2`. WP4 starts once WP3 has pushed its export surface (`packages/api/src/ee/**` index and service signatures), since WP4 imports `TeamMember`, `OrgRole`, `WorkspaceOwner` types from it. WP1's CLAUDE.md rewrite is its last commit.
9. **Gate is unchanged:** `pnpm check`, `pnpm test`, `cargo test --workspace`, and the gateway-e2e free-surface suites green on the assembled `phase0/foundation` branch, with Redis absent.
