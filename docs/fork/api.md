# API (`packages/api`)

Everything the fork adds to the shared `@onecli/api` package: the always-on entitlement layer, the
authorization/workspace access law, the org control-plane routers, and a handful of fork-only
extras (budgets, agent defaults, key `lastUsedAt`, condition-syntax validation, the client-cert
route). See [`../upstream-sync/v2-migration/api-ee-behaviour.md`](../upstream-sync/v2-migration/api-ee-behaviour.md)
for the behaviour spec and [`../upstream-sync/v2-migration/ts-seams.md`](../upstream-sync/v2-migration/ts-seams.md)
for the provider-slot/export-surface inventory this was built from.

Registration/auth-gate specifics live in [`auth-and-registration.md`](auth-and-registration.md);
remote-gateway CSR handling lives in [`remote-gateway-relay.md`](remote-gateway-relay.md).

## Purpose

Upstream gates RBAC, the org admin surface (members/groups/domains), workspace sharing, budgets,
and granular access behind an enterprise license, with a null/no-op arm for unlicensed builds. This
fork removes the license axis entirely: `isEntitled()` always returns `true`
([`src/lib/entitlements.ts`](../../packages/api/src/lib/entitlements.ts)), so `CAPS.rbac` and every
other entitlement-derived capability the server computes are always on
([`src/lib/env.ts`](../../packages/api/src/lib/env.ts) — `capabilitiesFor(EDITION_INFO, { entitled: isEntitled() })`).
`packages/api/src/ee/` is the clean-room Apache-2.0 rewrite of what upstream ships as licensed code
at the same path, same export names — see [`src/ee/index.ts`](../../packages/api/src/ee/index.ts)'s
`registerEeRoutes`, mounted unconditionally under `/v1` with **no `requireEnterprise` middleware**.

"Rewrite" does not mean the directory only holds the features above. Upstream's cloud-only
surfaces that the fork dropped (Cognito identity, SSO/JIT/SCIM, Stripe and AWS-Marketplace billing,
KMS crypto and the KMS SSH CA, the Redis client/event bus, Discord notifications, app availability)
still exist under `src/ee/` as null or no-op stand-ins, because free code imports those symbols and
`plan.md` principle 4 ("trim, don't port") keeps the callers compiling instead of editing them.
Nothing mounts or configures them; they are inert by construction, not disabled by a flag.

## Design decisions that differ from upstream

| Decision                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isEntitled()` hardcoded `true`; `entitlements-guard.ts` deleted                                                                         | Same "always entitled" principle as the gateway — no license flag exists in this fork ([`plan.md`](../upstream-sync/v2-migration/plan.md) Principle 3).                                                                                                                                                                                                                                                                                                                                                  |
| `apps/web`'s `CAPS` (client bundle) is computed _without_ `entitled`, and stays a genuinely different flag from the server's `CAPS.rbac` | A client bundle can't know its own entitlement at build time in a licensed world; this fork's web build still reads it from `/v1/instance` at runtime rather than baking it in, so `apps/web/src/lib/env.ts`'s `capabilitiesFor(EDITION_INFO)` (no `entitled` arg) is a live, separate flag, not dead code — a Phase 0 follow-up item that was flagged as "looks dead" and confirmed NOT dead on investigation.                                                                                          |
| Workspace access is bindings-only, with a GROUP arm added in Phase 2                                                                     | An org owner/admin reaches every workspace in the org; a member reaches only workspaces with a direct `workspace_access` binding OR an indirect one via a `groupId` binding on a group they belong to. A group binding must belong to the workspace's own org — the same org fence the free principal-set CTE applies — so membership in another org's group can never leak access in ([`authorization-service.ts`](../../packages/api/src/ee/services/authorization-service.ts) module doc, spec §2.3). |
| Management (rename/share/delete) never comes from a group binding, regardless of the role stored on the row                              | Group rows are always stored as `member` anyway, but the rule is explicit: widening this would let anyone who can edit group membership escalate to workspace management.                                                                                                                                                                                                                                                                                                                                |
| Members/groups/domains/usage/budgets/org-rename all require an **org-scoped** credential; a workspace-scoped key gets 403                | Deliberate weakening relative to the pre-v2 fork, decided during the Phase 0 review — see [`phase2-plan.md`](../upstream-sync/v2-migration/phase2-plan.md) close-out.                                                                                                                                                                                                                                                                                                                                    |
| `PATCH /org` (rename) requires **owner**, not admin                                                                                      | Matches upstream's existing owner-only rename gate; the web Org General page mirrors this by gating the form on owner, not admin ([`phase3-plan.md`](../upstream-sync/v2-migration/phase3-plan.md) vetting note 5).                                                                                                                                                                                                                                                                                      |
| Domain claim cap answers 400 (not 409); DNS timeout answers 400 "DNS lookup failed, try again"                                           | Deliberate wire-shape choices made during Phase 2, recorded so nothing "fixes" them back toward the pre-v2 fork's shapes.                                                                                                                                                                                                                                                                                                                                                                                |
| `condition-syntax.ts` validator is dependency-free (no Zod)                                                                              | The web condition builder imports it **at runtime** for inline validation, so the API's `ruleConditionSchema` and the web's inline checker can never drift apart ([`src/validations/condition-syntax.ts`](../../packages/api/src/validations/condition-syntax.ts)).                                                                                                                                                                                                                                      |
| `clientCertEnrollSchema` is `.strict()`                                                                                                  | Any extra field (a `keyPem`, `privateKey`, …) 400s outright instead of being silently stripped — a client that misunderstands the CSR-only enrollment flow gets a clear error, not a request that quietly drops what it sent ([`src/validations/client-cert.ts`](../../packages/api/src/validations/client-cert.ts)).                                                                                                                                                                                    |
| `mintClientCert` refuses a non-loopback, non-`https` `GATEWAY_INTERNAL_URL`                                                              | A Phase 4 senior-review must-fix: the prior fallback to the public gateway origin would have sent `X-Gateway-Secret` in clear over a reachable network (see [`remote-gateway-relay.md`](remote-gateway-relay.md)).                                                                                                                                                                                                                                                                                       |
| `api_keys.last_used_at` write is throttled, not unconditional                                                                            | Avoids write-amplifying on every authenticated request for a value the UI only needs "fresh enough" — mirrors the gateway's own throttle (`middleware/auth/api-key.ts`, `services/api-key-service.ts`).                                                                                                                                                                                                                                                                                                  |

## HTTP contracts (org control plane, all under `/v1`)

| Router                           | Routes                                                                                                                                                  | Auth                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `/org/members`                   | `GET /` (limit, cursor, q, status); `GET /:userId/groups`; `POST /` `{email, name?}`; `DELETE /:userId`; `PATCH /:userId` (`{status}` or `{ssoExempt}`) | org admin                           |
| `/org/groups`                    | `GET`/`POST /`; `GET`/`PATCH`/`DELETE /:groupId`; `GET`/`PUT /:groupId/members`; `PUT`/`DELETE /:groupId/members/:userId`                               | org admin                           |
| `/org/domains`                   | `GET`/`POST /`; `POST /:domainId/verify`; `DELETE /:domainId`                                                                                           | org admin                           |
| `/org/usage`                     | `GET /`                                                                                                                                                 | org member, org-scoped credential   |
| `/org/budgets`                   | `GET`/`POST /`; `PATCH`/`DELETE /:id`                                                                                                                   | org admin, org-scoped credential    |
| `PATCH /org`                     | `{name}`                                                                                                                                                | owner                               |
| `/workspaces/:id/access`         | `GET /`; `PUT /` (full replace)                                                                                                                         | read + `requireWorkspaceManagement` |
| `/workspaces/:id/agent-defaults` | `GET /`; `PUT`/`DELETE /connections/:connectionId`                                                                                                      | `requireWorkspaceManagement`        |
| `POST /v1/gateway/client-cert`   | enroll/renew a relay's client cert                                                                                                                      | workspace-scoped `oc_` key          |

Cross-org ids answer 404. Audit events: `MEMBER` create/update/delete, `WORKSPACE` update,
`GROUP` create/update/delete, `DOMAIN` create/verify/delete, `ORGANIZATION` update, `GRANT`
update/delete, `BUDGET` create/update/delete — all via `withAudit` (see the root `CLAUDE.md`'s
Audit Logging section).

## Entry points

| Feature                           | File(s)                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entitlement                       | [`src/lib/entitlements.ts`](../../packages/api/src/lib/entitlements.ts), [`src/lib/edition.ts`](../../packages/api/src/lib/edition.ts) (`capabilitiesFor`), [`src/lib/env.ts`](../../packages/api/src/lib/env.ts) (`CAPS`)                                                                                                                                                                  |
| Authorization + workspace service | [`src/ee/services/authorization-service.ts`](../../packages/api/src/ee/services/authorization-service.ts), [`src/ee/services/workspace-service.ts`](../../packages/api/src/ee/services/workspace-service.ts), [`src/ee/services/workspace-management-guard.ts`](../../packages/api/src/ee/services/workspace-management-guard.ts)                                                           |
| Org routers                       | [`src/ee/routes/{org-members,org-groups,org-domains,org-usage,org-budgets,workspace-access,agent-defaults}.ts`](../../packages/api/src/ee/routes/), mounted by [`src/ee/index.ts`](../../packages/api/src/ee/index.ts)                                                                                                                                                                      |
| Groups service                    | [`src/ee/services/group-service.ts`](../../packages/api/src/ee/services/group-service.ts)                                                                                                                                                                                                                                                                                                   |
| Domains service                   | [`src/ee/services/org-domain-service.ts`](../../packages/api/src/ee/services/org-domain-service.ts)                                                                                                                                                                                                                                                                                         |
| Usage service                     | [`src/ee/services/usage-service.ts`](../../packages/api/src/ee/services/usage-service.ts)                                                                                                                                                                                                                                                                                                   |
| Budgets service                   | [`src/ee/services/budget-service.ts`](../../packages/api/src/ee/services/budget-service.ts)                                                                                                                                                                                                                                                                                                 |
| Agent defaults                    | [`src/ee/services/agent-default-connections-service.ts`](../../packages/api/src/ee/services/agent-default-connections-service.ts)                                                                                                                                                                                                                                                           |
| Org rename                        | [`src/routes/org.ts`](../../packages/api/src/routes/org.ts) (`PATCH /org`), [`src/validations/org.ts`](../../packages/api/src/validations/org.ts)                                                                                                                                                                                                                                           |
| `lastUsedAt`                      | [`src/services/api-key-service.ts`](../../packages/api/src/services/api-key-service.ts), [`src/middleware/auth/api-key.ts`](../../packages/api/src/middleware/auth/api-key.ts)                                                                                                                                                                                                              |
| Condition validation              | [`src/validations/condition-syntax.ts`](../../packages/api/src/validations/condition-syntax.ts), [`src/validations/policy-rule.ts`](../../packages/api/src/validations/policy-rule.ts)                                                                                                                                                                                                      |
| Client-cert route                 | [`src/routes/gateway.ts`](../../packages/api/src/routes/gateway.ts) (`POST /client-cert`), [`src/lib/gateway-client-cert.ts`](../../packages/api/src/lib/gateway-client-cert.ts) (`mintClientCert`), [`src/validations/client-cert.ts`](../../packages/api/src/validations/client-cert.ts), [`src/services/client-host-service.ts`](../../packages/api/src/services/client-host-service.ts) |
| Registration gate                 | see [`auth-and-registration.md`](auth-and-registration.md)                                                                                                                                                                                                                                                                                                                                  |
| Quota/no-op seams                 | [`src/ee/services/quota-service.ts`](../../packages/api/src/ee/services/quota-service.ts) — `assertFeatureAllowed`/`assertCanShareWorkspace` etc., no-op in this always-entitled fork                                                                                                                                                                                                       |

## Env vars

| Var                         | Purpose                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ONECLI_REGISTRATION`       | `open`/`invite` (default `invite`) — see [`auth-and-registration.md`](auth-and-registration.md). Documented in `.env.example`. |
| `GATEWAY_INTERNAL_URL`      | Node→gateway internal calls (1Password `op://` resolution, client-cert issuance); falls back to `gatewayHttpOrigin()`.         |
| `GATEWAY_INTERNAL_SECRET`   | Shared secret for the gateway↔Node internal endpoints.                                                                         |
| `POLICY_PROOF_DATABASE_URL` | Gates `.pg.test.ts` suites (real Postgres); must be set in CI.                                                                 |

## Testing

- **Unit tests** (`.test.ts`) sit beside every service/route file listed above.
- **pg-proof tests** (`.pg.test.ts`, gated on `POLICY_PROOF_DATABASE_URL`): e.g.
  [`src/ee/services/workspace-service.pg.test.ts`](../../packages/api/src/ee/services/workspace-service.pg.test.ts),
  [`src/ee/services/organization-service.pg.test.ts`](../../packages/api/src/ee/services/organization-service.pg.test.ts),
  [`src/ee/services/agent-default-connections-service.pg.test.ts`](../../packages/api/src/ee/services/agent-default-connections-service.pg.test.ts),
  [`src/services/client-host-service.pg.test.ts`](../../packages/api/src/services/client-host-service.pg.test.ts).
- **Hermetic env normalization**: [`src/testing/hermetic-env.ts`](../../packages/api/src/testing/hermetic-env.ts)
  strips ambient hazard vars (`DATABASE_URL`, `REDIS_HOST`, etc.) before every test file loads, so a
  developer's shell exports can't silently change which edition a suite runs as.
- Known-environmental (not a fork regression): 7 hosted-agent `.pg.test.ts` suites
  (cron/processes/due-work/ssh/conversation/home-sync/channels) fail on a local Postgres whose
  `TimeZone` isn't UTC (e.g. `America/Mexico_City`) against timezone-naive columns — byte-identical
  against untouched upstream 8ea47cd.

## Known limitations / follow-ups

- **OpenAI budgets are accepted and stored but not enforced** — enforcement waits on the gateway's
  OpenAI meter (see [`gateway.md`](gateway.md)).
- **Role-mappings** have no API surface (deferred with the web Groups page).
- **`invalidateGatewayCacheForOrg`** flushes per workspace API key, so a workspace with no API key
  is never flushed — a pre-existing, unfixed gap.
- **Dead `!CAPS.rbac` arms** were removed from most free files in a Phase 2 tidy commit; `apps/web/src/lib/nav-config.ts`
  was deliberately left alone — its `CAPS.rbac` reads the client-only, still-live entitlement flag
  described above, not the server's always-true one.

## History

| PR                                                 | What it added here                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#53](https://github.com/whybutter/onecli/pull/53) | Phase 0: `isEntitled()` always true, minimal real `workspace-service`/`authorization-service`/`workspace-management-guard`                                           |
| [#55](https://github.com/whybutter/onecli/pull/55) | Phase 2: org routers (members/groups/domains/usage/budgets), workspace-access group arm, agent defaults, `lastUsedAt`, condition-syntax validator, `!CAPS.rbac` tidy |
| [#58](https://github.com/whybutter/onecli/pull/58) | Phase 4: client-cert route, `client_hosts` service, validations                                                                                                      |
