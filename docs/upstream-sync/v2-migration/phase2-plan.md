# Phase 2 (API control plane) implementation plan

Branch `phase2/api`, stacked on `phase0/foundation`. Three work packages for three parallel developers. Specs: `api-ee-behaviour.md` (§0, §1, §2, §4.2, §8.1, Appendix A/B), `ts-seams.md` (§C, §D, §H), `phase0-plan.md` follow-ups. Fork sources on branch `legacy/v1.45` and `origin/feat/agent-default-connections` of the main checkout. Wire contract for every response: `apps/web/src/lib/api/types.ts`.

## Corrections to the brief, found by reading the tree

1. Granular-access shape validators (spec §5) already exist from Phase 0 (`ee/granular-access/**`); only the optional Dropbox folder browser remains, and it is not planned.
2. `listWorkspaces` already returns `owner {name,email,isCurrentUser}`, `resourceCount`, `canManage`. Item "ownerEmail" is dropped.
3. `eeRuleActionGate` and the onprem gate are already allow-all; nothing to change.
4. `registerEeRoutes` is a stub and no `requireEnterprise` middleware exists; routers simply do not call one. Do not create one.
5. `ApiKey` has no `lastUsedAt` column and v2 has no "list my keys" route (one personal key per user and scope via `ensureApiKey`/`regenerateApiKey` in `routes/user.ts`). Scope is narrowed accordingly.
6. `services/agent-service.ts` `createAgent` (not `routes/agents.ts`) is where LLM auto-attach runs; the agent-defaults hook goes there.
7. `Budget`/`BudgetSpend` already match the shared design decision; no migration.
8. Migrations end at `20260908020202_conversation_app_turn_cap`; new ones sort after it.

## Shared file and ordering

`packages/api/src/ee/index.ts` (`registerEeRoutes`) is appended to by all three WPs: one `app.route(...)` per line, alphabetical by prefix; the orchestrator resolves the textual merge. WP-A owns its header comment. No other file is touched by two WPs (`routes/agents.ts` gets one added argument from WP-B only; `ee/services/organization-service.ts` gets WP-A's cascade edits in the body and WP-B's `renameOrganization` appended at the bottom). WP-B and WP-C call `authorization-service` functions whose signatures do not change, so they can start before WP-A's group arm merges.

## WP-A (L, 4–5 days): RBAC group arm, org routers, cascade

Free files: `packages/api/src/lib/legacy-project-compat.test.ts` (un-skip the `/access` alias test), `packages/api/src/ee/index.ts`.

- `ee/services/authorization-service.ts`: the GROUP arm. `hasWorkspaceAccessBinding` and `visibleWorkspacesWhere` also match a `workspace_access` row whose `groupId` names a group the user is a member of (the group must itself be bound to the workspace; mirror the query shape of the free `services/policy-simulate/principal-set.ts` without importing it). `canManageWorkspace` stays user-binding only (spec §2.3: group bindings never confer management). Update the file doc.
- `ee/services/team-service.ts`: add `listMembersPage` (cursor envelope per §0.4), `suspendMember`, `reinstateMember`, `groupsFor(userId)`; `changeMemberRole` gains the IdP-managed-role check against `GroupRoleMapping` (real read; nothing populates the table yet). Revocation stays the constant `"skipped"`.
- New `ee/services/group-service.ts`: CRUD + membership per §4.2, manual source only; `setGroupMembers` full-replace in one transaction validating org membership; idempotent add/remove; SCIM-lock branch present but unreachable.
- New `ee/services/org-domain-service.ts`: port the fork's service per §8.1 (normalisation incl. punycode, public-mailbox blocklist, 16-byte hex token, global domain uniqueness, TXT `onecli-verification=<token>` via `node:dns/promises`, idempotent re-verify, ENOTFOUND/ENODATA/SERVFAIL → "not found yet").
- New routers `ee/routes/{org-members,workspace-access,org-groups,org-domains}.ts` per the contract tables below; admin auth on members/groups/domains; read auth plus `requireWorkspaceManagement` in-handler on workspace-access (a GET by a non-manager is 403/404 per the guard). Every write through `withAudit` with `source: AUDIT_SOURCE.API` and the Appendix A metadata. 404, never 403, for cross-org ids.
- `ee/services/organization-service.ts` `deleteOrganizationContent`: delete `organizationDomain`, `organizationSsoConnection`, `organizationScimToken`, `appAvailabilityRule` before members; verify each FK's `onDelete` with a pg test rather than trusting the note.
- Tests: service suites (group arm incl. suspended member with a stale group binding, suspend/reinstate guards, groups §4.6, domain normalisation table with `node:dns` mocked), router contract suites per the tables, a pg proof for the group arm (bound group member can access but not manage).

## WP-B (M, 3–4 days): fork extras + `!CAPS.rbac` tidy

Free files: `services/api-key-service.ts` (`API_KEY_LAST_USED_THROTTLE_MS`, `recordApiKeyUse` pinned by key), `middleware/auth/api-key.ts` (select `key`, `lastUsedAt`; stamp after the role or access check passes on both key kinds), `routes/user.ts` (`lastUsedAt` in the personal-key response), `routes/org.ts` (`PATCH /` owner-only rename, `{name}` 1–255, audited UPDATE/ORGANIZATION), `providers/hooks/resource-hooks.ts` (optional `afterCreateAgent?(organizationId, workspaceId, agentId)`), `services/agent-service.ts` (call it best-effort after `autoAttachLlmKeys`; thread `organizationId` from `routes/agents.ts`'s auth context, one added argument, or look it up if callers are many), `packages/db/prisma/schema.prisma`, two migrations, and the tidy list below.

- Migration `..._add_api_key_last_used_at`: `ALTER TABLE "api_keys" ADD COLUMN "last_used_at" TIMESTAMP(3)`; model field `lastUsedAt DateTime? @map("last_used_at")`.
- Migration `..._add_workspace_agent_default_connections`: table `workspace_agent_default_connections` (id, workspace_id, connection_id, access, allow[], ask[], resources jsonb, created_by_user_id, timestamps; unique `(workspace_id, connection_id)`; FKs cascade from workspace and connection, set-null from user). Model `WorkspaceAgentDefaultConnection` with back-relations on `Workspace`, `AppConnection`, `User`. Because it cascades from `Workspace`, `deleteWorkspaceContent` needs no new line; pin that with a pg test.
- New `ee/services/usage-service.ts` + `ee/routes/org-usage.ts`: `GET /org/usage`, member-visible, org-scoped credential only (`auth.scope === "workspace"` → 403), 30-day window over `RequestLog` grouped by agent, `requests >= integrationCalls` clamp. Re-verify the "not total gateway traffic" caveat against v2's gateway telemetry writer before keeping the comment.
- New `ee/services/agent-default-connections-service.ts` (+ unit and pg tests), `ee/routes/agent-defaults.ts` mounted at `/workspaces/:workspaceId/agent-defaults` (GET, PUT `/connections/:id`, DELETE `/connections/:id`) behind `requireWorkspaceManagement`, applying through the real `services/grants-service.ts` `setConnectionGrant`; `eeResourceHooks.afterCreateAgent` applies the template; audited UPDATE/DELETE on GRANT with `target: "agent-default"`.
- Tidy commit at the end (separate from functional commits): remove the dead `!CAPS.rbac` arms in `middleware/auth.ts`, `middleware/auth/api-key.ts`, `apps/oauth-org.ts`, `routes/org-skills.ts`, `routes/runners.ts`, `routes/org-channels.ts`, `services/workspace-access-check.ts` (+ the comment in `providers/access-checker.ts`), `services/channels/agent-channel-service.ts`, `services/channels/providers/slack/shared-install-service.ts`, `apps/web/src/lib/nav-config.ts`; mark the follow-up done in `phase0-plan.md`.
- Tests: throttle and rotation-race for `recordApiKeyUse`; api-key middleware stamp; usage window/clamp/zeroed/scope-guard; agent-defaults service, pg round trip through `getAgentGrants`, hook wiring (called on genuine create, not on idempotent re-create, absent hook is fine); org rename owner-only.

## WP-C (M, 2–3 days): budgets API + condition-shape validation

Free files: `validations/policy-rule.ts` (widen `ruleConditionSchema` to `target body|header`, `operator contains|equals|regex|exists`, `value?` ≤ 1000, `key?` ≤ 500, with the `superRefine` rules), new `validations/condition-syntax.ts` (port verbatim, dependency-free), new `validations/policy-rule.test.ts`, `ee/index.ts`.

- New `ee/services/budget-service.ts` (port the fork's: `listBudgets`, `createBudget` with 404 non-org secret / 400 non-metered type / 409 duplicate, `updateBudget`, `deleteBudget`; spend read from `budget_spends` for the current period; `CENT_TO_NANOS = 10_000_000n`) and `ee/routes/org-budgets.ts` (admin, org-scoped credential only, zod `limitCents` positive int, `period` monthly|total default monthly, audited on BUDGET). `withAudit` with `organizationId` already flushes the gateway cache; do not double-flush.
- Metered types: `anthropic` and `openai` accepted at the API (the gateway meters Anthropic only in Phase 1; an OpenAI budget is stored but not enforced until the fast-follow, say so in the route doc).
- Tests: condition-shape matrix (legacy `{body, contains}` still valid, header without key rejected, invalid header name rejected, `exists` on body rejected, value-operators without value rejected, regex compile failure rejected, Rust-only syntax normalised), budget service and route contract.

## HTTP contracts (all under `/v1`)

| Router                           | Routes                                                                                                                                                              | Auth                                | Response types (`apps/web/src/lib/api/types.ts`)                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/org/members`                   | GET `/` (limit, cursor, q, status); GET `/:userId/groups`; POST `/` `{email, name?}`; DELETE `/:userId`; PATCH `/:userId` exactly one of `{status}` / `{ssoExempt}` | admin                               | `DirectoryPage<OrgMemberListRow>`, `DirectoryPage<GroupRow>`, `OrgMemberRow`, `UpdateOrgMemberInput` |
| `/workspaces/:id/access`         | GET `/`; PUT `/` full replace                                                                                                                                       | read + `requireWorkspaceManagement` | `WorkspaceAccessBindings`, `SetWorkspaceAccessInput`, `{added, removed, roleChanged}`                |
| `/org/groups`                    | GET, POST `/`; GET, PATCH, DELETE `/:groupId`; GET, PUT `/:groupId/members`; PUT, DELETE `/:groupId/members/:userId`                                                | admin                               | `DirectoryPage<GroupRow>`, `GroupRow`, `DirectoryPage<GroupMemberRow>`, `{added, removed}`           |
| `/org/domains`                   | GET, POST `/`; POST `/:domainId/verify`; DELETE `/:domainId`                                                                                                        | admin                               | `OrgDomain`                                                                                          |
| `/org/usage`                     | GET `/`                                                                                                                                                             | member, org-scoped credential       | `{periodStart, periodEnd, requests, integrationCalls, agents[]}` (from the fork's page)              |
| `/workspaces/:id/agent-defaults` | GET `/`; PUT, DELETE `/connections/:connectionId`                                                                                                                   | `requireWorkspaceManagement`        | `WorkspaceAgentDefault[]` (renamed from the fork)                                                    |
| `PATCH /org`                     | `{name}`                                                                                                                                                            | owner                               | the existing GET `/org` shape                                                                        |
| `/org/budgets`                   | GET, POST `/`; PATCH, DELETE `/:id`                                                                                                                                 | admin, org-scoped credential        | `BudgetListRow[]` (from the fork's hook)                                                             |

Errors per Appendix B; cross-org ids are 404. Audit events per Appendix A: MEMBER create/update/delete, WORKSPACE update (workspace-scoped), GROUP create/update/delete, DOMAIN create/verify/delete, ORGANIZATION update, GRANT update/delete, BUDGET create/update/delete.

## Risks

1. Group arm: "any group the user is in" instead of "a group bound to this workspace" would grant every group member every workspace. Diff the query against `principal-set.ts`'s shape in review.
2. 404-vs-403: every new router must keep the "unseen resource is 404" posture; a 403 leak is less restrictive than Phase 0's blanket 404.
3. Wire shapes: any deviation from `types.ts` is invisible until Phase 3. Each router exports its response type; the reviewer diffs against `types.ts`; Phase 3 switches the web to import those types.
4. Verify FK `onDelete` for the domain and related tables with a pg test.
5. `createAgent` signature: grep all callers before adding a parameter; prefer the lookup if callers are many.
6. Usage caveat must be re-verified against v2's gateway writer.
7. Condition-shape widening must equal the gateway's Phase 1 matcher; both derive from the fork, so they match by construction. Confirm the `(target, operator)` matrix in review.
8. Gateway-side `lastUsedAt` stamp cannot land in Phase 1 (the column arrives with Phase 2's migration). It is an integration-step item after both phases merge.

## Verification

Per WP from the worktree root: `pnpm db:generate` after schema edits; `pnpm --filter @onecli/api test -- <glob>`; pg suites with `POLICY_PROOF_DATABASE_URL` pointing at a scratch database created from `onecli_gateway_e2e_template` (superuser `postgresql://postgres@127.0.0.1:5432/postgres`) and migrated with `prisma migrate deploy`; `pnpm --filter @onecli/api check-types`, `lint`. Assembled: `pnpm check`, `pnpm test`, then browser QA in Phase 3.

---

## Orchestrator vetting notes (2026-09-15)

Accepted with these decisions:

1. **No cross-package type import from `packages/api` tests into `apps/web`.** Each router exports its response type from its own module; the reviewer diffs against `apps/web/src/lib/api/types.ts`; Phase 3 replaces the web duplicates with imports from `@onecli/api`. Record any deliberate shape difference in this file.
2. **Gateway `lastUsedAt` stamp** is deferred to the Phase 1 + Phase 2 integration step (a throttled `UPDATE api_keys SET last_used_at` in the gateway's key lookup, free `db` crate), because Phase 1's tree has no column to write.
3. **OpenAI budgets** are accepted by the API and stored; enforcement waits for the gateway's OpenAI meter (fast-follow). The route doc says so.
4. **Dropbox folder browser** is not planned; the picker in Phase 3 can be GitHub-only first.
5. **Free-file conflict surface for Phase 2:** `lib/legacy-project-compat.test.ts`, `services/api-key-service.ts`, `middleware/auth/api-key.ts`, `routes/user.ts`, `routes/org.ts`, `routes/agents.ts` (one argument), `providers/hooks/resource-hooks.ts`, `services/agent-service.ts`, `validations/policy-rule.ts`, new `validations/condition-syntax.ts`, `packages/db/prisma/schema.prisma`, two migrations, and the ten tidy files. Record the final list here when the phase closes.
6. **Merge order into `phase2/api`:** WP-A, then WP-B, then WP-C; the `ee/index.ts` mounts are resolved as pure insertions.
