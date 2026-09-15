# Phase 1 (gateway) implementation plan

Branch `phase1/gateway`, stacked on `phase0/foundation`. Three work packages for three parallel developers in separate worktrees. Specs: `gateway-ee-behaviour.md` (§2.3, §3, §4, §1.8, §11), `rust-seams.md` (§A, §C), `phase0-plan.md` follow-ups. Legacy fork sources on branch `legacy/v1.45` of the main checkout.

State at the start of the phase (confirmed by reading the tree): `granular_access` and `response` are complete from Phase 0; `principals.rs`, `rbac.rs`, `budget.rs` are the Phase 0 stubs this phase replaces; `org_routes`, `platform_llm`, `ha`, `cognito`, `kms_crypto` are permanent stand-ins, out of scope. The free call sites already invoke every replaced function unconditionally (`enforce.rs:140-165`, `context/auth.rs:448-462, 551-563`, `hooks.rs:112-216`, `connect.rs:663-673`), so the ee-side bodies are the only thing that changes in WP-A and WP-B.

## WP-A: RBAC rechecks + group principals (M, 3–4 days)

Owns: `crates/ee/ee/src/rbac.rs` (rewrite), `crates/ee/ee/src/principals.rs` (`find_principal_set` only; availability stays unrestricted), `crates/ee/ee/Cargo.toml` (`[dev-dependencies] policy-engine` back-edge for the parity test), `apps/gateway-e2e/tests/policy.test.ts` (un-skip "applies an org rule bound to an inherited group"; fixture `needsGroup` already seeds the right shape), new `apps/gateway-e2e/tests/rbac.test.ts`, and an additive-only extension of `apps/gateway-e2e/src/fixtures.ts`.

Fixtures extension (all optional, defaults preserve today's behaviour): `orgApiKeyRole?: "owner"|"admin"|"member"` and `apiKeyMembership?: { role?, status?: "active"|"suspended", workspaceBinding?: "direct"|"group"|"none" }`, wired into the existing `withApiKey`/`withOrgApiKey` block; model the group case on the existing `needsUserViaGroup` block without touching it.

`user_is_org_admin(pool, user, org)`: one row in `organization_members` with `user_id`, `organization_id`, `status <> 'suspended'`, `role IN ('owner','admin')`. DB error → `Err` (the auth layer maps any error to the uniform 401).

`user_can_manage_workspace(pool, user, workspace)`: active membership in the workspace's org (join `workspaces` to `organization_members` on org id, `status <> 'suspended'`), then any of: role owner/admin; a `workspace_access` row for this workspace with `user_id`; a `workspace_access` row for this workspace with a `group_id` the user belongs to via `group_members`. `created_by_user_id` is never consulted. One query. **No caching** (spec §3.2/§3.4); DB error → `Err`.

`find_principal_set(pool, workspace, org)`, the CTE in words: (1) `direct_groups` = `workspace_access.group_id` for the workspace, joined to `groups` and fenced `groups.organization_id = org`; (2) `candidate_users` = `workspace_access.user_id` for the workspace ∪ `group_members.user_id` for `direct_groups`; (3) `all_users` = candidates INNER JOIN `organization_members` on user id, `organization_id = org`, `status <> 'suspended'`; (4) `all_groups` = `direct_groups` ∪ every org-fenced group any `all_users` member belongs to. Distinct ids. Any DB error propagates (the caller refuses the CONNECT; never collapse to an empty set). Parity test: direct-only world equals the free `find_direct_user_principals`.

Tests: rbac decision table s14a–s14k (spec §3.5) as DB tests; principal CTE DB tests (direct, via group, suspended dropped, cross-org group ignored, group-of-resolved-user added); e2e `rbac.test.ts`: member org key → 401 on `/v1/org/approvals/pending`, admin → 200, workspace key with direct binding / group binding / none, suspended member → 401.

## WP-B: budgets end to end (L, 4–5 days)

Owns: `crates/ee/ee/src/budget.rs` split into `budget/{binding,spend,meter,pricing,anthropic}.rs` (keep the Phase 0 types and their derives verbatim), new `apps/gateway-e2e/tests/budget.test.ts`. **No free-file edits**: `CacheStore::incrby(key, u64, ttl)` already has the right semantics (TTL only on insert) and `add_spend` never sees a non-positive delta; `hooks.rs` and `connect.rs` already call the budget functions per spec §4.5; the `Budget`/`BudgetSpend` Prisma models already match the design decision (unique `(secretId, organizationId)`, `BudgetSpend` PK `(secretId, organizationId, period)` with `organizationId` holding the rendered subject). No migration.

Data flow:

1. Connect (free): `matching: Vec<db::SecretRow>` is already the host-filtered, rule-selected secret set. That is the eligible set.
2. `resolve_bindings(pool, org, matching, _entitled)`: `SELECT secret_id, limit_cents, period FROM budgets WHERE organization_id = $1 AND secret_id = ANY($2)`. DB error → warn + empty (fail-open). `limit_cents <= 0` → skip with warn. `period == "total"` → Total else Monthly. Subject always `Org(org)`. `secret_type` from the matching row. `limit_nanos = cents × 10^7`.
3. `pre_forward` (free): per binding, `is_over_budget` → 403 via the existing `response::budget_exceeded`.
4. `is_over_budget` = `read_spent_nanos >= limit_nanos` (inclusive). Key `budget:spend:{secret_id}:{subject}:{period_key}`; `period_key` = `m:YYYY-MM` (UTC) or `total`.
5. Cache miss → durable floor `SELECT spent_nanos FROM budget_spends WHERE secret_id=$1 AND organization_id=$2 AND period=$3` with `$2` = the rendered subject string `org:<id>` (unit-test that bind), error/no row → 0, then `set_raw(key, floor, ttl)`. TTL: Monthly = seconds to end of UTC month; Total = 90 days. The clobber window between floor read and set is accepted and documented.
6. `has_meter` = `anthropic` only in Phase 1 (decision below). `wrap_metered`: real accumulators. SSE: line-buffered `data:` lines, `message_start` → model + `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; `message_delta` → `output_tokens` when > 0 (last positive wins); unterminated-line buffer cap 512 KiB. JSON: buffer up to 256 KiB, parse at finish, over-cap → $0 with warn. Emit `telemetry::on_request(meta.into_event(Some(BudgetCharge{...})))` exactly once at end or on drop (keep the existing `Option::take` pattern).
7. Pricing (nanos per token in/out/cache-write/cache-read): opus 5000/25000/6250/500, sonnet 3000/15000/3750/300, haiku 1000/5000/1250/100, unknown or missing model → opus with one warn; all-zero usage → 0 with no warn; saturating arithmetic.
8. Sink (free `flush_budget`) aggregates per `(secret_id, subject, period_key)` and calls `BudgetSpendSink::add_spend`.
9. `add_spend`: `nanos <= 0` → return. (a) `cache.incrby(key, nanos, ttl)`; failure → warn, continue. (b) upsert `budget_spends ... ON CONFLICT DO UPDATE SET spent_nanos = spent_nanos + EXCLUDED.spent_nanos RETURNING spent_nanos`. (c) reconcile-as-floor: re-read the cache; if absent or lower than the returned total, `set_raw` to the total; **never lower it** (a newer concurrent charge already in the cache must survive). DB error → warn, return. Nothing propagates.

Tests: pricing pinned values (Opus 1000 in + 100 out = 7,500,000; Sonnet 4,500,000; Opus 1000 cache-write + 1000 cache-read = 6,750,000; unknown == Opus; all-zero → 0); `period_key` formats, key format, TTL formulas; DB tests for bindings over org + workspace secrets, cold-cache rehydrate from a floor row, and the reconcile race (cache seeded higher than the durable total is not lowered); e2e: spend seeded exactly at the limit → 403 `budget_exceeded` (pins `>=`); under budget → 200 and `budget_spends` shows recorded spend after the async flush (reuse the suite's telemetry-poll helper if one exists).

## WP-C: condition-matching superset, truncated-body fail-closed, Dropbox folders amendment (M, 2–3 days)

Owns: `crates/policy/src/condition_match.rs` (free crate, port of the fork's matcher), `crates/proxy/src/forward.rs` (one line), every `condition_match::matches`/`ConditionBody` call site inside `crates/policy-engine/src/**` (enumerate with grep as the first step; the `headers` parameter threads through them), `crates/ee/ee/src/granular_access/dropbox.rs` (`folder_policy`), `gateway-ee-behaviour.md` §1.8 text, and `crates/policy/Cargo.toml` (`memchr`, `regex`). Items D and E land in the same PR (see risk 7).

D. Condition shape `{target: body|header, operator: contains|equals|regex|exists, value?, key?}` with `deny_unknown_fields`; tri-state `CondEval { Match, NoMatch, Invalid }` where Invalid makes Block rules match and Allow rules fail; `exists` is header-only; `key` required for header; header matching iterates all values (any-value satisfies), invalid header name → Invalid; regex via `regex::bytes` with a 1 MiB size limit and a bounded 256-entry cache that also caches compile failures; byte-level matching, no lossy UTF-8; `log_unevaluable` warn-once-per-rule. Keep `ConditionBody`, `BufferedBody`, `prepare_body`, `needs_body_buffer`, `ONECLI_CONDITION_BODY_BUFFER_BYTES` and the `[4 KiB, 8 MiB]` clamp unchanged. Truncated bodies: a `contains`/`regex` hit inside the observed prefix is still a Match; a miss on a truncated body is Invalid (resolved by polarity); `equals` is Invalid on any truncated body.

E. `forward.rs:650`: `condition_buffer.as_ref().filter(|b| !b.truncated).map(|b| b.bytes.as_slice())` so the Dropbox guard sees `None` and denies. E2E in `resource-boundary.test.ts`: `ONECLI_CONDITION_BODY_BUFFER_BYTES=4096`, path field placed after the cap → 403 (must fail before the fix).

F. `dropbox.rs`: replace `allowed_folders` with `enum FolderPolicy { Unrestricted, DenyAll, Restricted(Vec<String>) }`: no `folders` key → Unrestricted; empty array → DenyAll; non-empty array with zero string entries → DenyAll (the amendment); strings normalising to only root → Unrestricted; else Restricted. `needs_body` only for Restricted; `enforce` denies DenyAll before the pathless allowlist. Spec §1.8 gains the row `{folders: [42]} → 403 deny-all`.

Tests: operator × target matrix, tri-state resolution for every Invalid cause, multi-value headers, `deny_unknown_fields`, regex size limit and failure caching, truncated-body polarity cases; dropbox `[42]` → deny-all, `["/"]` → unrestricted, `[]` → deny-all, `[42, "/valid"]` → restricted; update the existing `body_contains_match_case_insensitive` test per the decision below rather than leaving it red.

## Verification

Per WP from `apps/gateway`: `cargo test -p ee` (or `-p policy -p policy-engine -p proxy` for WP-C), `cargo clippy --workspace --all-targets -- -D warnings`; e2e from `apps/gateway-e2e` with `E2E_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres E2E_TEMPLATE_DB=onecli_gateway_e2e_template pnpm test:e2e -- <file>` (`test:e2e`, not `:no-build`). Assembled: `cargo build --workspace && cargo test --workspace && cargo clippy ... && cargo doc --workspace --no-deps`, full e2e; the only remaining `scenario.skip` should be app availability.

## Risks

1. Caching the RBAC rechecks would reopen the demotion/unshare lag the rechecks exist to close. Do not cache.
2. A DB error in the principal CTE must propagate, never become an empty set (Phase 0 Risk 2 still applies).
3. `add_spend`'s `nanos <= 0` guard is what makes the unsigned `incrby` safe; document the invariant loudly.
4. Reconcile-as-floor direction: only ever raise the cache. The DB test must simulate the race.
5. The condition-matcher port changes behaviour on a Block-rule path (see decisions); the WP-C PR description must repeat the flags.
6. WP-C's `policy-engine` call-site enumeration was not completed at planning time; it is compile-checked, so the risk is schedule, not safety.
7. Items D and E are two fixes to the same hazard (an over-cap body passing a security check) and must ship together.

Sequencing: WP-A merges first (it owns the `fixtures.ts` extension); WP-B does not touch `fixtures.ts`; WP-C touches no file WP-A or WP-B touches.

---

## Orchestrator vetting notes (2026-09-15)

Accepted as written, with these decisions where the plan asked for one:

1. **Metering is Anthropic-only in Phase 1.** OpenAI metering (the fork had a price table for it) is a fast-follow after the Anthropic path is proven end to end; note it in the follow-ups.
2. **Body `contains` stays case-insensitive.** Upstream's insensitive match is the safer default for Block rules (an agent cannot evade a body block by changing case) and it is the behaviour existing v2 policies assume. Implement it as ASCII case folding over bytes (no lossy UTF-8 conversion), so the "no lossy UTF-8" property of the port is kept. `equals` is byte-exact; `regex` is as written with `(?i)` available; header values are case-sensitive with `(?i)` as the escape hatch, matching the fork. Keep the existing `body_contains_match_case_insensitive` test green. Document the divergence from the fork in the module doc.
3. **Truncated-body semantics as recommended:** a prefix hit for `contains`/`regex` is a Match; a prefix miss is Invalid and resolves by polarity; `equals` is Invalid on any truncated body.
4. **D and E ship in one PR**, as the plan requires.
5. **WP-A merges first.** WP-B rebases onto it only if `fixtures.ts` has moved under it, which it should not.
6. **Free-file conflict surface for Phase 1:** `crates/policy/src/condition_match.rs` (rewrite), `crates/policy/Cargo.toml`, `crates/proxy/src/forward.rs` (one line), the `policy-engine` call sites WP-C enumerates, `apps/gateway-e2e/src/fixtures.ts` (additive), `apps/gateway-e2e/tests/{policy,resource-boundary}.test.ts`. Record the final list in this section when the phase closes.
7. **Follow-ups this phase does not take:** OpenAI metering; the `User` budget subject; app availability loader; the truncated-body behaviour inside `ee::granular_access` itself (E fixes it at the call site, which is sufficient).
