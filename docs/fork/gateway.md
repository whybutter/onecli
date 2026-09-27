# Gateway (Rust)

The fork's Rust additions to `apps/gateway`, on top of upstream v2.6.0. Everything here lives in
the workspace crates listed below; the one exception (`apps/gateway/crates/ee/ee`) is documented
in full because it is a from-scratch, clean-room Apache-2.0 rewrite of what upstream ships as a
licensed crate — see [`../upstream-sync/v2-migration/gateway-ee-behaviour.md`](../upstream-sync/v2-migration/gateway-ee-behaviour.md)
for the behaviour spec it was built from and [`../upstream-sync/v2-migration/rust-seams.md`](../upstream-sync/v2-migration/rust-seams.md)
for the call-site inventory.

For the mTLS / CSR / relay / binding stack specifically, see
[`remote-gateway-relay.md`](remote-gateway-relay.md) — this page covers it only at a summary level.

The `ee/ee` crate also carries permanent stand-ins for what the fork dropped — `ha` (Redis HA),
`platform_llm` (platform trial credit), `cognito`, `kms_crypto` — because `onecli-gateway`'s
`wiring.rs` constructs them positionally and `plan.md` principle 4 keeps that free code untouched.
They are unit structs or infallible constructors whose methods error or return the free default;
do not turn them into real implementations without a decision to bring the feature back.

## Purpose

Upstream's gateway ships RBAC, budgets, and granular per-connection access scoping behind an
enterprise license (a stub arm runs otherwise). This fork has no license flag: `entitled()`
(`apps/gateway/crates/common/src/edition.rs:42`) always returns `true`, so the licensed arm is the
only arm. The fork also adds an entirely new capability upstream doesn't have at all: a remote
relay stack (mTLS, client-certificate issuance, a `relay` CLI subcommand, and cert↔token tenant
binding enforcement) so a gateway can serve agents that aren't on the same host.

## Design decisions that differ from upstream

| Decision                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entitled()` is a hardcoded `true`, not a license check                                                                        | "This fork has no `ENTERPRISE_ENABLED` switch and no unlicensed lane: every deployment ... is always entitled" ([`plan.md`](../upstream-sync/v2-migration/plan.md) Principle 3). Kept as a function, not inlined, so every existing `entitled()` call site needed no further changes.                                                                                                                                                                                                                                                                                                                                       |
| Granular access ships GitHub + Dropbox in full in Phase 0, not stubbed                                                         | `proxy::connect` calls `has_token_scoper`/`scope_token`/`has_request_guard` unconditionally in every edition; stubbing `has_request_guard("dropbox")` to `false` would silently serve the stored Dropbox token with no scope check at all — a real credential leak, not a conservative default (Phase 0 vetting notes, [`phase0-plan.md`](../upstream-sync/v2-migration/phase0-plan.md) §"Follow-ups"). There is **no AWS granular-access module** — only GitHub and Dropbox register per-connection scoping; AWS appears solely as a domain-wildcard list in `policy-engine`'s outbound host catalog, a different feature. |
| `intersect_policies`/`denies_everything` implement the full decision table immediately, not exact-match-only                   | A partial version would leave a window where a nested-folder or cross-org boundary composes _wider_ than intended — a scope leak in the unsafe direction ([`phase0-plan.md`](../upstream-sync/v2-migration/phase0-plan.md) vetting note 2).                                                                                                                                                                                                                                                                                                                                                                                 |
| Body `contains` matching is ASCII case-insensitive; `equals` is byte-exact; `regex` is Invalid (not Match) on a truncated body | Matches the safer default for Block rules and existing v2 policy assumptions; `regex` is not monotone under truncation (an anchor or `\b` can match a prefix and then fail on the full body), so a prefix hit isn't sound evidence — treating it as Invalid avoids letting an Allow rule grant on unseen bytes ([`phase1-plan.md`](../upstream-sync/v2-migration/phase1-plan.md) vetting notes 2–3).                                                                                                                                                                                                                        |
| A truncated request body is passed as `None` to `enforce_request`, never as the partial bytes                                  | `proxy::hooks` previously passed the buffered-but-incomplete body straight through, so a body over the buffer cap whose _prefix_ happened to parse as complete JSON would pass the Dropbox guard unchecked — a fail-open bug caught during Phase 0 (`phase0-plan.md` follow-ups).                                                                                                                                                                                                                                                                                                                                           |
| Binding enforcement exempts the plain listener by **listener kind**, never by `identity.is_some()`                             | An mTLS handshake with an unparseable CN/SAN also yields no identity, and that case must be denied (nothing in the cert can satisfy the allowlist) — treating "no identity" as "must be the plain listener" would wave through exactly the request this feature exists to block (`binding` crate module doc).                                                                                                                                                                                                                                                                                                               |
| `GATEWAY_BINDING_ENFORCEMENT` has three modes (`off`/`log`/`enforce`), not a binary switch                                     | Lets an operator watch what enforcement _would_ deny before flipping it on for real — the rollout path the whole mTLS/relay effort was gated on (see [`remote-gateway-relay.md`](remote-gateway-relay.md)).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `db::stamp_api_key_last_used` only writes when the existing value is missing or older than a floor interval                    | A naive unconditional `UPDATE` on every authenticated request would write-amplify on high-traffic keys for no product value; the throttle keeps `last_used_at` fresh enough for the UI without hammering the row.                                                                                                                                                                                                                                                                                                                                                                                                           |

## Entry points

| Feature                                                | Crate                                     | Key items                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entitlement                                            | `common`                                  | `edition::entitled()` — [`crates/common/src/edition.rs`](../../apps/gateway/crates/common/src/edition.rs)                                                                                                                                        |
| RBAC rechecks                                          | `ee`                                      | `RbacRoleResolver` — [`crates/ee/ee/src/rbac.rs`](../../apps/gateway/crates/ee/ee/src/rbac.rs), installed via `wiring::install_role_resolver` in [`crates/onecli-gateway/src/wiring.rs`](../../apps/gateway/crates/onecli-gateway/src/wiring.rs) |
| Principals (group membership)                          | `ee`                                      | [`crates/ee/ee/src/principals.rs`](../../apps/gateway/crates/ee/ee/src/principals.rs)                                                                                                                                                            |
| Condition-matching superset                            | `policy`                                  | `contains`/`equals`/`regex`/`exists` — [`crates/policy/src/condition_match.rs`](../../apps/gateway/crates/policy/src/condition_match.rs)                                                                                                         |
| Policy/guard evaluation                                | `policy-engine`                           | [`crates/policy-engine/src/{evaluate,enforce,catalog}.rs`](../../apps/gateway/crates/policy-engine/src/)                                                                                                                                         |
| Budgets + metering                                     | `ee`                                      | `BudgetPeriod`/`BudgetSubject`/`BudgetBinding`/`BudgetSpendSink` — [`crates/ee/ee/src/budget.rs`](../../apps/gateway/crates/ee/ee/src/budget.rs) and `budget/{anthropic,binding,meter,pricing,spend}.rs`                                         |
| Granular access (GitHub, Dropbox)                      | `ee`                                      | [`crates/ee/ee/src/granular_access.rs`](../../apps/gateway/crates/ee/ee/src/granular_access.rs) + `granular_access/{github,dropbox}.rs`                                                                                                          |
| Org-wide approvals poll                                | `ee`                                      | `GET /v1/org/approvals/pending` — [`crates/ee/ee/src/org_routes.rs`](../../apps/gateway/crates/ee/ee/src/org_routes.rs)                                                                                                                          |
| Licensed-feature error bodies                          | `ee`                                      | [`crates/ee/ee/src/response.rs`](../../apps/gateway/crates/ee/ee/src/response.rs)                                                                                                                                                                |
| mTLS listener, client CA, CSR issuance, relay, binding | `client-ca`, `relay`, `binding`, `server` | see [`remote-gateway-relay.md`](remote-gateway-relay.md)                                                                                                                                                                                         |
| Last-used stamp                                        | `db`, `context`                           | `db::stamp_api_key_last_used` — [`crates/db/src/lib.rs:270`](../../apps/gateway/crates/db/src/lib.rs), called from [`crates/context/src/auth.rs`](../../apps/gateway/crates/context/src/auth.rs)                                                 |

## Env vars

| Var                         | Default                     | Purpose                                                                                                                                                               |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EDITION`                   | unset → `onprem`            | Selects `cloud` vs `onprem` fail-fast checks in `main.rs`; unrelated to entitlement (see [`../fork/README.md`](README.md)). Unreachable in this fork per `CLAUDE.md`. |
| `GATEWAY_TEST_DATABASE_URL` | unset → pg-proof tests skip | Shared migrated Postgres the `ee`/`context`/`policy-engine` in-crate DB tests write against, row-namespaced by `test_prefix()`.                                       |

The mTLS/relay/binding env vars (`GATEWAY_MTLS_PORT`, `GATEWAY_TLS_CERT`, `GATEWAY_TLS_KEY`,
`GATEWAY_CLIENT_CA*`, `GATEWAY_BINDING_ENFORCEMENT`, `GATEWAY_PLAIN_BIND`, `GATEWAY_INTERNAL_SECRET`,
`RELAY_*`) are documented in [`remote-gateway-relay.md`](remote-gateway-relay.md) — **none of them
are in `.env.example`** (see the README's env-var gap note).

## Testing

- **In-crate unit tests** run with `cargo test --workspace` (no `default-members`, so a bare
  `cargo build`/`test`/`run` in `apps/gateway` covers all 20 members — see the comment in
  [`Cargo.toml`](../../apps/gateway/Cargo.toml)).
- **pg-proof tests** (gated on `GATEWAY_TEST_DATABASE_URL`, real Postgres, no per-test template):
  [`crates/ee/ee/src/rbac/pg_test.rs`](../../apps/gateway/crates/ee/ee/src/rbac/pg_test.rs) (RBAC decision table, spec labels s14a–s14k), [`crates/ee/ee/src/principals/pg_test.rs`](../../apps/gateway/crates/ee/ee/src/principals/pg_test.rs), [`crates/context/src/auth/pg_test.rs`](../../apps/gateway/crates/context/src/auth/pg_test.rs), [`crates/policy-engine/src/enforce_pg_test.rs`](../../apps/gateway/crates/policy-engine/src/enforce_pg_test.rs).
- **Black-box e2e** in `apps/gateway-e2e` (spawns the real binary), gated on `E2E_TEMPLATE_DB` (a
  migrated template database each test clones) plus an admin database URL. Relevant suites:
  `tests/rbac.test.ts`, `tests/budget.test.ts`, `tests/resource-boundary.test.ts`,
  `tests/api-key-usage.test.ts`, `tests/policy.test.ts` — see [`remote-gateway-relay.md`](remote-gateway-relay.md#testing)
  for the mTLS/relay/binding suites and their own template databases.

## Known limitations / follow-ups

- **OpenAI metering** is not implemented — `budget/anthropic.rs` is the only accumulator; the
  Anthropic path shipped first as a proof of concept ([`phase1-plan.md`](../upstream-sync/v2-migration/phase1-plan.md) vetting note 1).
- **The `User` budget subject** is deferred (phase1-plan follow-ups).
- **App availability** stays deferred: the gateway keeps the pure `principals::app_availability_block`
  function and an always-unrestricted loader, per [`plan.md`](../upstream-sync/v2-migration/plan.md) decision 3.
- **Dropbox folder browser** was never planned; the picker (web) is GitHub-only ([`phase2-plan.md`](../upstream-sync/v2-migration/phase2-plan.md) vetting note 4).
- **Multi-instance operation (HA)** is a licensed feature that stays entitlement-gated behind
  `crate::ee::ha::check_ha_entitlement` even in this always-entitled fork's own code path: setting
  `REDIS_HOST` still requires the check to pass (it always does here), but Redis itself is dropped
  from the compose stack — single gateway instance is the known ceiling ([`plan.md`](../upstream-sync/v2-migration/plan.md) decision 6).

## History

| PR                                                 | What it added here                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [#53](https://github.com/whybutter/onecli/pull/53) | Phase 0: `entitled()` always true, GitHub/Dropbox granular access shipped in full, RBAC resolver stub |
| [#54](https://github.com/whybutter/onecli/pull/54) | Phase 1: real RBAC rechecks, group principals, budgets end to end, condition-matching superset        |
| [#58](https://github.com/whybutter/onecli/pull/58) | Phase 4: `client-ca`, `relay`, `binding` crates; second `Entrypoint`; internal client-cert route      |
| [#59](https://github.com/whybutter/onecli/pull/59) | Consolidation onto `v2`: gateway `api_keys.last_used_at` stamp                                        |
