# W2-A1a — Org-scope endpoints: approved plan

**Status:** vetted and approved. This is a **backend-only** PR. No UI.

## Why this ships first, alone

Two shipped pages are **silently broken today** because these endpoints don't exist:

1. **Org Policy rule form** (`lib/policy-editor/policy-rule-form.tsx:309-320`) — its Connection and Secret target pickers call `useConnections("organization")` and `useScopedSecrets("organization")`. Both 404, so **both pickers are permanently empty** and an org rule can never target a credential.
2. **Budgets tab** (`hooks/use-budgets.ts:32`, `useMeteredSecrets`) — the create-budget secret picker reads `/v1/org/secrets`. 404, always empty, so **no budget can ever be created.**

This PR repairs both. That is its standalone value; the Global Connections UI comes later.

## The key finding

**The UI is already scope-aware; the backend is not.** Every component (`AppsTab`, `SecretsContent`, `ConnectedTab`, `ConnectionsTabs`, `AppDetail`, `SecretCard`, `SecretDialog`) already takes `pageScope: PageScope` / `basePath`, and the client already routes to `/v1/org/*`. The endpoints were EE-only upstream and the OSS org router never gained them.

**No schema change. No migration. No service work.** `packages/db/prisma/schema.prisma` already has `scope` + `organizationId` on `Secret`, `AppConnection`, and `AppConfig` with the right indexes, and `packages/api/src/services/resource-scope.ts` (`ResourceScope`, `scopeWhere`, `scopeCreate`, `scopeOwnership`, `appConfigKey`, `isOrgScope`) is already consumed by every service. This is a **routing job.**

## The precedent to follow exactly

`packages/api/src/routes/org/policy.ts`:

```ts
app.use("*", auth({ requireProject: false, role: "admin" }));
app.use("*" /* reject auth.scope === "project" */);
registerPolicyRoutes(app, {
  resolveScope: (auth) => ({ organizationId: auth.organizationId }),
  auditScope: (auth) => ({ organizationId: auth.organizationId }),
});
```

`registerPolicyRoutes(app, cfg)` in `routes/policy.ts` is the shared-handlers-with-injected-scope pattern. **Do not fork handlers. Extract and inject.**

### Guard-stack note — important

`apiFetch` always attaches `X-Project-Id` when the cookie exists, so `authenticateSession` returns a context with **both** `projectId` and `organizationId`. The guard rejects only API-key `scope: "project"`. **`resolveScope` must return `{ organizationId }` ONLY** — including `projectId` would make `scopeWhere` `OR` project rows back in. This is spelled out in `org/policy.ts:47-49`; repeat that comment.

## Steps

### 1. `routes/org/secrets.ts` → `/v1/org/secrets`

Refactor `routes/secrets.ts` into `registerSecretRoutes(app, { resolveScope, auditScope })`, mounted from both routers:

- project: `{ projectId: requireProjectId(auth), organizationId: auth.organizationId }` for GET; `{ projectId }` for writes — **preserve today's exact semantics**
- org: `{ organizationId }`

`routes/secrets.ts` currently has **no audit calls** and mutates via `getResourceHooks().beforeCreateSecret` + `invalidateGatewayCache(c.req.raw)`. The org write path must use `withAudit` with `{ organizationId }` so `invalidateGatewayCacheForOrg` fires — **an org secret that keeps injecting for a cache window after deletion is the failure mode.** Follow `org/budgets.ts`'s `auditBase`.

`createSecret` already rejects 1Password at org scope with a written-out reason; keep and surface that error.

### 2. `routes/org/connections.ts` → `/v1/org/connections`

Extract the three handlers the same way. `disconnectOwnedConnection` / `renameOwnedConnection` already branch on `connection.scope === "organization"`, but call `requireProjectId(auth)` inside `findOwnedConnection`'s `OR` clause — **parameterize that on the injected scope** so an org router with no project context doesn't throw.

### 3. `routes/org/apps.ts` → `/v1/org/apps/*`

Extract the config/blocklist handlers from `routes/apps.ts` (≈ lines 217-233 `/configured`, 846-964 `/config*`, 966-1034 `/blocklist*`) into `registerAppConfigRoutes(app, cfg)`, mounted at both scopes. `app-config-service` needs nothing — `appConfigKey`, `countAppConfigDependents`, and the `dependents` field on `AppConfigStatus` were built for exactly this.

### 4. Register in `routes/org/index.ts`

Three `app.route(...)` lines. The file's doc comment invites this.

### 5. Tests

New `routes/org/{secrets,connections,apps}.test.ts` mirroring `org/policy.test.ts` + `org/budgets.test.ts`. Cover: admin-only 403, cross-org isolation, and that org GETs do **not** return project rows.

## Explicitly OUT of scope for this PR

- **Org OAuth connect** (`GET /v1/apps/:provider/authorize` + `/callback`) — hard-400'd at `apps.ts:383-392`. Leave it.
- **Org credentials connect** (`POST /v1/apps/:provider/connect`) — hard-400'd at `apps.ts:720-731`. Leave it.
- Deleting the `oauthOrg` / `orgAppConfig` provider seams. Leave them; they're inert.
- Any UI.

## Risks

**R5 — the sharpest trap in the slice.** `apiFetch` always sends `X-Organization-Id` when the org cookie exists. If a future org-connect branch keys on that header, **every project connect from a browser that has ever used the org switcher would silently become org-scoped.** Not triggered by this PR (connect stays 400'd), but do not introduce a header-keyed scope decision anywhere here.

**R6 — org config removal has cross-project blast radius.** `deleteAppConfig` disconnects every project connection the org config minted (`app-config-service.ts:26-42`). The endpoint must return `dependents` (it already exists on `AppConfigStatus`) so the future UI can warn.

**R8 — `routes/apps.ts` is 1035 lines and upstream-merged.** Keep the diff to scope-derivation helpers plus mechanical `projectId` → `scope` substitutions. **Do not reflow the file.**

**R2 — invalidation breadth.** Creating an org secret changes what every project page shows as inherited. Keep invalidation at `queryKeys.{secrets,connections}.all()` breadth; do not narrow it.
