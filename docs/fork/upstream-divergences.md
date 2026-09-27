# Upstream Divergences

This is the fork's **upstream-conflict surface**: every file *outside* the three `ee/`
directories (`apps/gateway/crates/ee`, `packages/api/src/ee`, `apps/web/src/ee`) that this fork
has modified relative to upstream commit `8ea47cd` (`upstream/main`, tag-equivalent to v2.6.0 plus
two fixes). The `ee/` directories are expected to diverge completely — they are Apache-2.0
clean-room rebuilds of code upstream ships under its enterprise license, so they are out of scope
here. Everything below is a file a future `git merge upstream/main` (or the `/upstream-sync`
skill's merge trial) can actually conflict on.

Derived from:

```
git diff --stat 8ea47cd HEAD -- . ':!apps/web/src/ee' ':!packages/api/src/ee' ':!apps/gateway/crates/ee'
```

cross-referenced against each PR's own "Free-file conflict surface" section (`gh pr view <N>
--repo CarbonoDev/onecli`, N in 53–59) and, for Phase 0, the "Phase 0 free-file conflict surface"
section of [`docs/upstream-sync/v2-migration/phase0-plan.md`](../upstream-sync/v2-migration/phase0-plan.md#l613).
Every path listed below was verified to exist in the diff at the time of writing (2026-09-27).

## How `/upstream-sync` should use this file

The skill's review workflow (`.agents/skills/upstream-sync/SKILL.md`, step 3) asks for a
`forkContext` string — "the local work this branch carries." Feed it this file (or the relevant
section of it) instead of reconstructing that context from `git log`: it is the authoritative,
already-verified list of exactly which non-`ee` files upstream can conflict with, why each one
changed, and which PR to consult for the full rationale. When upstream touches a file listed here,
the reviewing agent should read that file's row plus the linked PR/plan section before deciding
how to reconcile the merge.

## PR / phase index

| # | Title | Phase |
| --- | --- | --- |
| [#53](https://github.com/whybutter/onecli/pull/53) | Rebase on v2.6.0, replace `ee/` with Apache-2.0 code | Phase 0 |
| [#54](https://github.com/whybutter/onecli/pull/54) | Real RBAC rechecks, group principals, budgets, condition-matching superset | Phase 1 (gateway) |
| [#55](https://github.com/whybutter/onecli/pull/55) | Org routers, group access-law arm, budgets API, fork extras | Phase 2 (API) |
| [#56](https://github.com/whybutter/onecli/pull/56) | Real web dashboard surfaces on the Phase 2 API | Phase 3 (web) |
| [#57](https://github.com/whybutter/onecli/pull/57) | Invite-only registration as an instance setting | Phase 5a |
| [#58](https://github.com/whybutter/onecli/pull/58) | Remote-gateway relay stack (mTLS, CSR, relay, binding) | Phase 4 |
| [#59](https://github.com/whybutter/onecli/pull/59) | Consolidates #56, #57, #58 + the gateway last-used stamp onto `v2` | integration |

Where a file was shaped by more than one PR, all are listed; the plan doc linked is the one with
the fullest rationale.

## Root & repository meta

| Files | Reason | PR |
| --- | --- | --- |
| `.github/workflows/{ci,publish,release}.yml`, `.github/workflows/{cla,ci-cache-seed}.yml` (deleted) | Repo identity (`whybutter/onecli`, `ghcr.io/whybutter/*` images), CLA process dropped, e2e runs without Redis | #53 |
| `CLA.md`, `LICENSE-ENTERPRISE` (deleted), `NOTICE`, `CONTRIBUTING.md`, `README.md`, `SECURITY.md` | Whole tree re-licensed Apache-2.0, no enterprise license text remains | #53 |
| `CLAUDE.md` | Rewritten for the OSS-only v2 tree | #53, then updated for `ONECLI_REGISTRATION` | #57 |
| `package.json`, `turbo.json`, `packages/api/package.json`, `apps/web/package.json` | Repo identity / build graph | #53 |
| `.env.example` | `ONECLI_REGISTRATION` documented | #57 |
| `.github/pull_request_template.md` | Minor identity edit during the rebase | #53 |
| `scripts/dev.mjs`, `scripts/install.sh` | `ENTERPRISE_ENABLED` removed from dev tooling; install script identity | #53 |
| `scripts/publish-workflow.test.mjs` | Asserts the four-image publish matrix is a documented subset | #53 |
| `scripts/cloud-boundary.test.mjs` (deleted) | Asserted a cloud/OSS boundary that no longer exists in an OSS-only fork | #53 |
| `docs/nanoclaw-integration.md`, `docs/paid-parity/**`, `docs/upstream-sync/**` | Brought over from the pre-v2 fork's history (not authored by the v2 migration itself) | #53 |

## `apps/gateway` (Rust, non-`ee`)

| Files | Reason | PR |
| --- | --- | --- |
| `Cargo.toml`, `Cargo.lock` | New crate members (`binding`, `client-ca`, `relay`, `server` split) and dependencies (`memchr`, `x509-parser`, `arc-swap`, `sqlx` `time`, `time` `serde`) | #54 (`memchr`), #58 (rest) |
| `crates/common/src/edition.rs` | `entitled()` returns true unconditionally | #53 |
| `crates/onecli-gateway/{Cargo.toml,src/main.rs}` | New `relay` CLI subcommand, mTLS entrypoint wiring, binding-mode wiring | #58 |
| `crates/policy/{condition_match.rs,lib.rs,Cargo.toml}` | Condition-matching superset (`contains/equals/regex/exists`, tri-state truncated-body semantics) | #54 |
| `crates/policy-engine/{evaluate.rs,catalog.rs,enforce.rs,corpus_test.rs,Cargo.toml}` | Headers threaded through every policy-engine call site for the new condition types | #54 |
| `crates/proxy/src/{forward.rs,websocket.rs}` | Truncated-body fail-closed guard call site | #54 |
| `crates/proxy/src/response.rs` | New response builder(s) for the client-cert/relay paths | #58 |
| `crates/context/src/{lib.rs,auth.rs}`, `crates/context/src/auth/pg_test.rs` | `RbacRoleResolver` real rechecks, `GatewayState.client_ca`/`binding_mode` fields | #54 (rechecks), #58 (state fields) |
| `crates/context/src/auth.rs` (last-used call site) | `api_keys.last_used_at` stamp after the auth chain | #59 |
| `crates/db/src/lib.rs` | `client_hosts` queries, `last_used_at` UPDATE statement | #58, #59 |
| `crates/server/{Cargo.toml,src/lib.rs,src/mtls.rs,src/binding_enforce.rs,src/client_cert_route.rs}` | Second `Entrypoint` for mTLS, binding enforcement at both proxy doors, internal client-cert issuance route | #58 |
| `crates/binding/**`, `crates/client-ca/**`, `crates/relay/**` (new crates) | Binding enforcement, client CA / mTLS, relay sidecar — entirely new, ported from the pre-v2 flat gateway (PRs #2–#5 in the remote-gateway-hardening effort) onto the v2 crate workspace | #58 |

## `apps/gateway-e2e` / `apps/hosted-e2e`

| Files | Reason | PR |
| --- | --- | --- |
| `apps/gateway-e2e/{README.md,src/env.ts,src/gateway.ts,src/scenario.ts}` | Redis made optional (harness no longer requires `E2E_REDIS_HOST`) | #53 |
| `apps/gateway-e2e/src/fixtures.ts` | Additive fixtures for RBAC/group/budget scenarios | #54 |
| `apps/gateway-e2e/src/mtlsPki.ts` (new) | Shared mTLS test PKI helper (real leaf certs, `CA:FALSE`, `serverAuth`) | #58 |
| `apps/gateway-e2e/tests/{policy,resource-boundary}.test.ts` | Extended for the condition-matching superset | #54 |
| `apps/gateway-e2e/tests/{rbac,budget}.test.ts` (new) | RBAC recheck and budget-enforcement coverage | #54 |
| `apps/gateway-e2e/tests/api-key-usage.test.ts` (new) | `lastUsedAt` write-back coverage | #55, #59 |
| `apps/gateway-e2e/tests/{binding,client-cert,mtls,relay}.test.ts` (new) | mTLS handshake matrix, CSR issuance, relay round-trip, binding off/log/enforce | #58 |
| `apps/gateway-e2e/tests/{control,shutdown}.test.ts` | Adjusted for the Redis-optional harness | #53 |
| `apps/gateway-e2e/tests/{platform-llm,unlicensed}.test.ts` (deleted) | Asserted the unlicensed/hosted-platform arm, which no longer exists once entitlement is always true | #53 |
| `apps/hosted-e2e/{README.md,src/api-server.ts,src/env.ts,src/gateway.ts}` | Same Redis-optional / entitlement-always-true baseline | #53 |

## `packages/api` (non-`ee`)

| Files | Reason | PR |
| --- | --- | --- |
| `src/edition-defaults.ts`, `src/lib/entitlements.ts` (+test), `src/lib/entitlements-guard.ts` (deleted) | `isEntitled()` always true; the separate guard helper became dead code | #53 |
| `src/providers/hooks/{policy-validator,rule-action-gate}.ts`, `src/services/invitation-email.ts`, `src/testing/hermetic-env.ts` (+test), `src/providers/edition-resolution.test.ts` | Entitlement-always-true baseline adjustments | #53 |
| `src/licensing/**` (all deleted), `src/{licensing→lib}/third-party-notices.test.ts` (renamed) | Boundary-snapshot suites deleted rather than re-snapshotted; the whole tree is Apache-2.0 | #53 |
| `src/lib/better-auth.ts` | User-creation hook enforces the registration gate | #57 |
| `src/lib/env.ts` | `ONECLI_REGISTRATION`, `GATEWAY_INTERNAL_URL` and related vars | #57, #58 |
| `src/lib/registration.ts` (+test, +pg.test), `src/lib/onprem-session-provider.pg.test.ts` | Invite-only registration logic and the case-insensitive-equality review fix | #57 |
| `src/lib/gateway-client-cert.ts` (+test, new) | CSR forwarding to the gateway's internal issue route | #58 |
| `src/lib/identity-conflict.test.ts`, `src/lib/legacy-project-compat.test.ts` | RBAC-always-on / entitlement-always-true test adjustments | #53, #55 |
| `src/app.ts` | Mounts the client-cert route | #58 |
| `src/apps/oauth-org.ts`, `src/routes/{org-skills,runners,org-channels}.ts`, `src/services/workspace-access-check.ts`, `src/services/channels/agent-channel-service.ts`, `src/services/channels/providers/slack/shared-install-service.ts` (+tests) | Tidy: removed dead `!CAPS.rbac` arms now that RBAC is on everywhere | #55 |
| `src/middleware/auth.ts`, `src/middleware/auth/api-key.ts`, `src/middleware/auth/api-key-last-used.test.ts` (new) | Throttled `lastUsedAt` write-back after key auth | #55 |
| `src/middleware/error-handler.ts`, `src/services/errors.ts` | Client-cert error mapping | #58 |
| `src/providers/access-checker.ts`, `src/services/workspace-access-check.ts` (+test) | Workspace-access group-binding arm | #55 |
| `src/providers/hooks/resource-hooks.ts` | `afterCreateAgent` hook for agent-default connections | #55 |
| `src/routes/{user,org,agents}.ts` (+tests) | Org routers mounted, `PATCH /org` rename, agent defaults | #55 |
| `src/routes/{channel-routes,org-apps,instance,instance-ssh,workspaces}.test.ts` | RBAC-always-on / router-mount test adjustments | #53, #55 |
| `src/routes/gateway.ts`, `src/routes/gateway-client-cert.test.ts` (new) | `POST /v1/gateway/client-cert` route | #58 |
| `src/services/agent-service.ts` (+test, new) | Agent-default-connections service | #55 |
| `src/services/api-key-service.ts`, `src/services/api-key-usage.test.ts` (new) | `ApiKey.lastUsedAt` | #55 |
| `src/services/audit-service.ts` | `MINT` audit action for `client-host` | #58 |
| `src/services/client-host-service.ts` (+pg.test, new) | `client_hosts` CRUD, renewal fenced to the caller's workspace | #58 |
| `src/services/{conversation,cron,due-work,home-sync,processes,ssh}.pg.test.ts` | Hermetic-env / entitlement-always-true adjustments | #53 |
| `src/services/policy-onprem-validator.test.ts` | Condition-shape matrix widened | #55 |
| `src/validations/client-cert.ts` (new) | CSR PEM validation, 16 KiB cap | #58 |
| `src/validations/condition-syntax.ts` (new, +test) | Dependency-free condition-shape validator shared with the web condition builder | #55 |
| `src/validations/org.ts` | Org-rename validation | #55 |
| `src/validations/policy-rule.ts` (+test) | Condition matrix widened to match the gateway's Phase 1 superset | #55 |

## `packages/db`

| Files | Reason | PR |
| --- | --- | --- |
| `prisma/schema.prisma`, `migrations/20260915120000_add_api_key_last_used_at`, `migrations/20260915120100_add_workspace_agent_default_connections` | `ApiKey.lastUsedAt`, `WorkspaceAgentDefaultConnection` | #55 |
| `migrations/20260915120200_add_client_hosts` | `ClientHost` table for CSR-issued certs | #58 |

## `apps/web` (non-`ee`)

| Files | Reason | PR |
| --- | --- | --- |
| `package.json` | Repo identity | #53 |
| `src/app/(dashboard)/org/[orgId]/(admin)/{groups,settings/domains,settings/general,settings/sso}/*`, `.../usage/page.tsx` → `org/[orgId]/usage/*` | ComingSoon placeholder wrappers (Phase 0) become real pages (Phase 3); SSO permanently redirects | #53 (wrappers/redirect), #56 (real pages) |
| `src/app/(dashboard)/org/[orgId]/global-connections/(tabs)/budgets/*` (new), `_components/global-connections-tabs.tsx` | Budgets placed as an org-scoped Global Connections tab, not per-workspace | #56 |
| `src/app/(dashboard)/agents/_components/agents-content.tsx`, `.../connections/_components/connections-tabs.tsx` | BYO is the primary create-agent door on self-host | #56 |
| `src/app/(dashboard)/overview/_components/api-key-card.tsx` (+test) | Key masking, `lastUsedAt` display | #56 |
| `src/app/(dashboard)/install/_components/install-content.tsx` (+test) | Install-page adjustments | #56 |
| `src/app/auth/login/{page.tsx,sso/page.tsx}` (+test), `src/app/auth/signup/page.tsx` | Registration-gate UI (invite-only screen, hidden "Create an account") | #57 |
| `src/app/auth/login/sso/page.tsx` (baseline), `src/app/claim/page.tsx` (+test) | Permanently-dropped SSO/claim surfaces redirect instead of rendering a stub | #53 |
| `src/app/aws-marketplace/edition-gate*.test.ts` | Entitlement-always-true adjustments | #53 |
| `src/app/create-org/{page.tsx,loading.tsx}` (new) | Real create-org page, no org cap | #56 |
| `src/hooks/{use-agent-defaults,use-budgets,use-usage}.ts` (new), `src/hooks/use-org.ts` (+test), `src/hooks/use-instance.ts` | Dashboard data hooks for the Phase 2 routers | #56 |
| `src/lib/actions/{api-key,resolve-user,secrets}.ts` | Workspace-access group arm, agent-defaults plumbing | #55, #56 |
| `src/lib/agents/create-door.ts` (+test) | BYO as the primary create-agent door | #56 |
| `src/lib/api/{agent-defaults,budgets,keys,org,types,usage}.ts` | Response types imported from the routers instead of hand-copied | #56 |
| `src/lib/auth/{auth-errors,login-content-onprem,signup-content-onprem}.ts` (+test), `src/lib/auth/require-org-admin.ts` (+test, new) | Registration-gate client logic, `requireOrgAdmin` guard | #57 |
| `src/lib/components/{cloud-upsell,condition-builder,request-app-slot-local}.tsx`, `{coming-soon-card,feature-coming-soon-dialog}.tsx` (new), `{enterprise-locked-card,license-required-dialog}.tsx` (deleted) | Entitlement-always-true placeholders; ComingSoon replaces license-gated cards | #53 |
| `src/lib/dashboard/{dashboard-header,sidebar-version}.tsx` | Baseline identity/entitlement adjustments | #53 |
| `src/lib/dashboard/{dashboard-sidebar,use-active-org}.tsx` (+tests) | Org switcher made query-backed so rename reaches the sidebar without a reload | #56 |
| `src/lib/granular-access/configs/github-app.ts`, `.../github-app/policy-dialog-content.tsx` (+test, new) | GitHub repository picker ships on self-host (`IS_CLOUD` gate removed) | #56 |
| `src/lib/install-command.ts` | Baseline identity adjustment | #53 |
| `src/lib/mask-secret.ts` (+test, new) | API-key masking helper | #56 |
| `src/lib/nav-config.ts` (+test) | Budgets/usage nav entries added, App Availability removed | #53 (baseline), #56 (nav entries) |
| `src/lib/plan-gate.tsx` (+test) | `usePlanGate` collapsed to a permanent no-op | #53 |
| `src/lib/policy-editor/{_components/org-identity-picker,editable-rule-row,resource-scope,resource-scope-types}.tsx` | Condition matrix widened; directory picker fed from the org routers | #55, #56 |
| `src/lib/workspaces/{page,settings-page}.tsx`, `_components/workspace-card.tsx` | Workspace-access and agent-defaults cards | #56 |

## `docker/`

| Files | Reason | PR |
| --- | --- | --- |
| `docker-compose.yml` | `ONECLI_REGISTRATION` threaded to both api and web | #57 |
| `docker-compose.yml`, `{agent,api,channel-adapter,gateway,runner,web}.Dockerfile` | Image renames to `ghcr.io/whybutter/onecli-*` | #53 |
