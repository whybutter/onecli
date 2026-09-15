# OneCLI gateway `ee` crate — behavioural specification (upstream v2.6.0)

Source of truth: `apps/gateway/crates/ee/ee/src/**` at
`/Users/marco/Projects/ai-agents/onecli/.claude/worktrees/upstream-ref`, its in-crate
unit/DB tests, the free-side call sites that consume it (`proxy`, `policy-engine`,
`context::auth`, `onecli-gateway/src/wiring.rs`, `server`), and the black-box
suite `apps/gateway-e2e/tests/*.test.ts`. This document describes **what the crate
does at runtime** so a clean-room replacement can be built without reading the
original. No code is reproduced; SQL is described in words.

Companion document (separate agent): the API/signature inventory. This one owns
decision rules, failure posture, caching, atomicity, limits, and test-pinned edges.

---

## 0. Frame: how upstream gates the crate, and what the fork changes

### 0.1 Entitlement model in upstream

| Concept           | Upstream rule                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Edition`         | `EDITION` env: `cloud` (case-insensitive, trimmed) → Cloud; anything else/unset (incl. legacy `oss`) → Onprem. Read once (OnceLock).                                               |
| `entitled()`      | Cloud → always true. Onprem → true only if `ENTERPRISE_ENABLED` trimmed equals `true` (case-insensitive) or `1`. Blank/`yes`/`0`/`false` → false. Read once.                       |
| Rule of the house | Gates are evaluated at **load / startup / connect-resolution**, never on the per-request hot path. Functions take `entitled: bool` as a parameter so both arms are table-testable. |

### 0.2 Where each licensed feature degrades when unlicensed (upstream)

| Feature                           | Gate location (free crate)                                                                                                    | Unlicensed behaviour                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budgets                           | `resolve_bindings(.., entitled)` early-returns empty                                                                          | No bindings → no `is_over_budget` DB read, no metering, no 403                                                                                                 |
| Resource scopes (granular access) | `proxy::connect::stamp_resource_scopes` stamps `session_policy = None` when not entitled                                      | Credentials inject **unscoped**; every granular hook short-circuits on `None`. Even _narrowing_ policies are dropped (decided posture, pinned by e2e).         |
| Group principals                  | `policy_engine::load_connect_v2` runs the free `find_direct_user_principals` instead of `find_principal_set`                  | Group ids never resolve; group-bound rules (including BLOCK) never match; users granted only via a group are not principals. Direct-user targeting stays free. |
| App availability                  | `policy_engine::load_available_apps(.., entitled)` returns the unrestricted default                                           | No DB reads; `app_availability_block` is a no-op                                                                                                               |
| RBAC role rechecks                | `wiring::install_role_resolver` installs the resolver only when `enforce_key_rechecks(edition, entitled)` (Cloud OR entitled) | Only the free LIVENESS gates run (active org member)                                                                                                           |
| Org approvals feed                | `org_routes` handler answers 403 `enterprise_license_required` at runtime (route stays mounted)                               | 403 (not 404)                                                                                                                                                  |
| HA (Redis stores)                 | `main` calls `check_ha_entitlement(REDIS_HOST, entitled)`                                                                     | A non-blank `REDIS_HOST` on an unlicensed process **refuses to boot** with a message containing "Enterprise license"                                           |
| Platform trial credit             | `platform_credential(.., entitled)` + `parse` requires Cloud                                                                  | Inert                                                                                                                                                          |
| Cognito / KMS                     | Not entitlement-gated; selected by edition/config                                                                             | Dead on self-host by code (Cognito needs Cloud) / by config (KMS only when `SECRET_ENCRYPTION_KEY` unset)                                                      |

### 0.3 Fork posture

The fork's replacement crate is **always entitled**. Every `entitled` parameter/branch
above collapses to the licensed arm. The fork also does **not** run Redis HA,
Cognito, KMS, platform credit, or cloud billing plans. Consequences are called out
per module under "Fork relevance" and collected in §12.

### 0.4 Request-path order (where the ee hooks sit)

HTTP forward (`proxy/src/forward.rs`), in order:

1. Body buffering decision: buffer when a body-needing policy rule could match
   (`needs_body_buffer`) **or** `granular_access::needs_request_body(...)` says so.
   Buffer cap = `MAX_CONDITION_BODY_BUFFER` (8 MiB default; env-tunable, clamped);
   past the cap the buffer is a **truncated prefix** flagged `truncated`.
2. Default interceptions (free).
3. `hooks::refuse_empty_scope` — 403 `resource_access_denied` (empty-scope wording)
   when `denies_everything(session_policy)`. Runs **before token interception**, so an
   empty scope never serves a cached token either.
4. Token-endpoint interception (free).
5. `app_availability_block(policy_host, path, available_apps)` → 403 `app_unavailable`.
   Runs **before policy evaluation** (availability wins over a block rule — pinned by e2e).
6. Policy engine v2 evaluate (block / rate-limit / approval / allow).
7. `hooks::prepare_request` — strips `Accept-Encoding` when any budget binding has a meter.
8. `materialize_injections` — mints deferred (resource-scoped) credentials now that the
   request is allowed. A mint failure → **502** `credential_unavailable` (free-side body).
9. Apply injections (→ `injection_count`).
10. `hooks::pre_forward`: (a) granular request guard → 403 `resource_access_denied`;
    (b) budget `is_over_budget` per binding → 403 `budget_exceeded`/`trial_credit_exhausted`;
    (c) free-plan call quota (Cloud only) → 429 `quota_exceeded`.
11. Manual approval hold (free).
12. Forward; response wrapped by `hooks::track_and_wrap` → budget meter on 2xx.

WebSocket upgrade (`proxy/src/websocket.rs`): steps 3 → 5 → 6 → 10 with
`injection_count = 0` (quota skipped) and `body = None`. No metering.

Known gap (documented upstream): step 8 precedes step 10, so a request refused by the
Dropbox guard, budget or quota has already minted a scoped GitHub token. Policy blocks
(step 6) never mint.

---

## 1. `granular_access` (+ `github`, `dropbox`)

### 1.1 Purpose

Restrict what an agent can reach _within_ a provider, driven by a per-connection
`session_policy` JSON object. Two enforcement styles:

- **Token-level** (`TokenScoper`): mint a credential the provider itself restricts.
  Only registered implementation: credential type `github_app` (GitHub App
  installation token scoped to a repository list).
- **Request-level** (`RequestGuard`): inspect each request. Only registered
  implementation: provider `dropbox` (folder allowlist).

A third seam, `ResourceAxis`, defines per-axis "containment" and is used for scope
composition between an ORG boundary and a WORKSPACE selection.

### 1.2 Inputs and outputs

| Input                                 | Source                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_policy: Option<Value>`       | Produced **only** by `proxy::connect::stamp_resource_scopes` from `InjectSelection` (`boundaries` ∩ `connections[id]`), via `intersect_policies`. DB row SELECTs hard-code `NULL` for this column — it is never persisted on the connection row. Cached inside `ConnectResponse` (60 s). |
| Policy shape                          | Resource policy = JSON object with exactly one recognised key: `repositories` (array of `owner/repo` strings) or `folders` (array of absolute Dropbox paths). Anything else (`null`, `{}`, an array of behavioural conditions, unknown key) is "not a resource policy".                  |
| Host / method / path / headers / body | From the request. Host is port-stripped before provider lookup (`apps::provider_for_host`).                                                                                                                                                                                              |
| Credentials JSON                      | Decrypted app-connection payload (`type`, `private_key`, `app_id`, `installation_id`, `access_token`, `expires_at`, …).                                                                                                                                                                  |

Outputs: `Option<Denial { reason, allowed: Vec<String>, rule_name }>` from the guard;
`Option<Result<(token, expires_at_unix)>>` from the scoper; composed policy `Option<Value>`.

No env vars. No DB access inside this module.

### 1.3 Recognised axes

| Axis key       | Provider / cred type      | `normalize(entry)`                                                | `covered_by(entry, boundary)`                                                                                                                                                                                                                                   |
| -------------- | ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories` | GitHub App (`github_app`) | ASCII-lowercase                                                   | Exact equality after lowercasing any boundary entry. Names never nest: `org/a` is not inside `org/a-extra`; `org` is not inside `org/a`.                                                                                                                        |
| `folders`      | Dropbox (`dropbox`)       | ASCII-lowercase, strip trailing `/` (account root → empty string) | If **any** boundary entry normalizes to the root (empty) → true (root boundary contains everything). Else `path_allowed(entry, normalized boundary)` (see §1.6). Note asymmetry: `/` as a _request target_ is refused; `/` as a _boundary_ is the widest scope. |

`intersect(a, b)` on an axis (symmetric): keep every entry of `a` covered by `b`, plus every
entry of `b` covered by `a`; normalize; sort; dedup. So `/clients` ∩ `/clients/acme` =
`[/clients/acme]` regardless of side; `[/]` ∩ `[/clients]` = `[/clients]`; siblings → `[]`.
Sorted+deduped output is load-bearing: the composed policy is part of an injection cache
key.

### 1.4 `intersect_policies(a, b)` decision table

| `a`                          | `b`                          | Result                                                                                                         |
| ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| None                         | None                         | None                                                                                                           |
| Some(x)                      | None / not-a-resource-policy | Some(x) (clone, un-normalized)                                                                                 |
| None / not-a-resource-policy | Some(y)                      | Some(y)                                                                                                        |
| not-a-resource-policy        | not-a-resource-policy        | None                                                                                                           |
| resource on axis K           | resource on axis K           | `{K: axis.intersect(normalized entries of a, normalized entries of b)}` — may be `{K: []}` (deny-all sentinel) |
| resource on axis K1          | resource on axis K2 ≠ K1     | Warn; `{K1: []}` (deny-all on the **first** argument's axis)                                                   |

"Not a resource policy" = JSON null, non-object, empty object, or object without a
recognised key. Raw entries that are not strings are ignored. Entries are normalized
before intersecting; a side whose recognised key holds a non-array yields an empty entry
list (→ deny-all when the other side has entries).

Pinned examples: `{repositories:[buckle/electron, buckle/api]}` ∩ `{repositories:[buckle/api]}`
= `{repositories:[buckle/api]}`; `[org/b, org/a, ORG/A]` ∩ `[org/a, org/b]` = `[org/a, org/b]`.

### 1.5 `denies_everything(policy)` decision table

| Policy                                                                                 | Result                                                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| None / `null` / `{}` / behavioural array / unknown key                                 | false                                                                                                 |
| `{repositories: []}` or `{folders: []}` (explicitly empty array of the recognised key) | **true**                                                                                              |
| `{repositories: ["org/a"]}`                                                            | false                                                                                                 |
| `{folders: ["/"]}`                                                                     | **false** — root is the widest scope; the check reads **raw** entries because normalization drops `/` |
| recognised key whose value is not an array                                             | false (no entry list)                                                                                 |

Consumers: `hooks::refuse_empty_scope` (HTTP + WS, 403 before anything), the connect
path (a denying policy returns a `Rules` result with **no** rules and **no** mint, carrying
the policy so the request is refused rather than passing uncredentialed), and the GitHub
scoper (defence in depth).

### 1.6 Scope composition (free-side, `policy_engine::inject_select`) — the contract the crate serves

- **Grant fold** (`collect`): identity law = _explicit identity required_; an unnamed org
  rule grants nothing. Last-match-wins per connection id; conditions objects ride along
  as the grant's policy.
- **Boundary fold** (`collect_boundaries`): org `allow` rules whose `conditions` is an
  **object** and whose identities are **empty or match** the agent/principals. Several
  boundaries for one connection compose by intersection (never last-wins; a later plain
  attach cannot evict a boundary).
- Merge: org-granted connections merge into workspace selections by intersection; then
  every boundary is applied (intersection) to whatever the agent ended up with. Result
  per connection: `Option<Value>`; a disjoint pick yields `{K: []}`.
- Provider-level grants ("all github connections at scope X") resolve their ids from DB
  later; `connect.rs::stamp_resource_scopes` applies `boundaries[id]` ∩ `connections[id]`
  there. Re-applying an already-composed boundary is idempotent.
- Fork note: under "always entitled" this stamping always happens.

### 1.7 GitHub App — token-level scoping mechanism (exact)

Mechanism: **token-scoped**, not a URL guard. `has_request_guard("github-app")` = false;
no request inspection of GitHub calls ever happens (a policy on GitHub never blocks a
request at the gateway).

Mint rules (`scope(creds, policy)`):

| Policy `repositories`                                                                  | Result                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent / not an array / array with no string entries **and** `denies_everything` false | `None` → caller falls through to ordinary (unscoped) refresh path                                                                                                                                                          |
| explicitly `[]` (denies_everything true)                                               | `Some(Err("empty repository allowlist denies all access; refusing to mint an unscoped token"))` — defence in depth; normally intercepted earlier by `refuse_empty_scope`                                                   |
| non-empty                                                                              | Requires `private_key`, `app_id`, `installation_id` strings in creds; missing → `Some(Err("GitHub App credentials incomplete, cannot refresh"))`. Else calls the shared GitHub installation-token mint with the repo list. |

The shared mint (free crate `apps::refresh_github_app_token`): RS256 app JWT
(`iat = now-60`, `exp = now+600`, `iss = app_id`), `POST
https://api.github.com/app/installations/{installation_id}/access_tokens` with headers
`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
`User-Agent: onecli-gateway`; body `{"repositories": [bare names]}` where each entry is
reduced to the text after the last `/` (owner stripped — GitHub's API takes repo names
within the installation). Non-2xx → error containing status + body.

Connect-time behaviour around the mint (free-side `proxy::connect`, must be preserved):

1. `granular_scoping_requested(policy)` = policy is a **non-empty JSON object** (any key).
2. **Deferral**: when the provider needs an access token, `has_token_scoper(cred type from
creds["type"])` is true, scoping is requested, and the host has no intercept rules, the
   connection returns **no rules yet** plus a `PendingInjection`; the mint happens only
   after the policy allows (`materialize_injections`). Selection/attribution
   (`winning_connection_id`, `session_policy`, label, finalizer, body transform, host
   rewrite) is decided up front.
3. **Resolution** (`resolve_access_token`): refresh when stored `expires_at < now` **or**
   scoping requested (a scoped token is minted per request even with a fresh stored token,
   and even when `expires_at` is absent). Try `scope_token` first; if it returns `None`,
   fall to the shared credential refresh. Only the scoper can produce a _scoped_ token.
   A scoped token is **never persisted**; an ordinary refresh is persisted.
4. **Fail-closed withhold**: if scoping was requested and no scoped token was minted (scoper
   declined, errored, creds incomplete, or the axis is not GitHub's) **and** the provider has
   no request guard → return no credential at all ("scoped credential required but not
   minted; withholding the credential"). For a deferred connection this surfaces as 502
   `credential_unavailable`; for a non-deferred one as no injection.
5. **Cache**: built rules cache under an `app_injection:` key that includes the composed
   policy, TTL = min(60 s, token remaining lifetime); TTL 0 → not cached.

"Not minted" therefore means: any outcome of step 3 in which the value came from
something other than the token scoper (or from nothing).

### 1.8 Dropbox — request-level guard (exact)

Applicability (all must hold, else pass-through / `None`):

- a session policy is present;
- port-stripped host resolves to provider `dropbox` via the app registry;
- `folder_policy(policy)` decodes to `Restricted(list)`: the `folders` key holds an
  array with at least one entry that normalizes (lowercase, strip trailing `/`) to
  something other than the account root.

`folder_policy(policy)` (Phase 1 WP-C amendment) is a three-way decode, not a
`Some`/`None` allowlist:

- **`Unrestricted`** (no guard): the `folders` key is absent, or the policy isn't
  an object at all; OR the key is present and holds an array where every string
  entry normalizes to the account root (e.g. `{folders: ["/"]}`) — root is the
  widest scope.
- **`DenyAll`** (guard denies unconditionally, before the pathless allowlist and
  every other check): the `folders` key is **present but unusable** — its value
  isn't an array at all (a string, number, `null`, object, or bool, e.g.
  `{folders: "/clients"}` or `{folders: null}`), **or** it's an array with
  **zero in-scope entries**: either explicitly empty (`{folders: []}`,
  ordinarily intercepted earlier by `denies_everything`, but the guard denies it
  too as defence in depth) **or** non-empty with zero usable STRING entries,
  e.g. `{folders: [42]}`. Both the non-array-value and the
  non-empty-but-garbage-array readings are the amendment: before it, either
  shape decoded as `Unrestricted` (a spec gap) — the fail-closed reading is to
  deny a RECOGNISED key in an unusable shape, not to fall back to "no
  restriction" and hand out an unscoped credential for a policy an
  administrator wrote to restrict access. A raw array with a MIX of garbage and
  usable entries (`{folders: [42, "/valid"]}`) decodes to
  `Restricted(["/valid"])` — the non-string entry is dropped, not fatal,
  matching `denies_everything`'s "raw entries that are not strings are ignored"
  rule elsewhere in this document.
- **`Restricted(list)`**: the normalized, non-empty allowlist — the only shape
  that triggers the guard above.

`needs_body(policy, host)` = `host == "api.dropboxapi.com"` **and** `folder_policy(policy)`
is `Restricted`. `DenyAll` needs no body either — it denies before ever consulting one. The
content host is decided from a header, so no buffering.

`enforce(allowed, host, path, headers, body)`; `endpoint` = path with query string removed:

| Step                                                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Pathless allowlist                                        | Allow outright: `/2/users/get_current_account`, `/2/users/get_space_usage`, `/2/users/get_account`, `/2/users/get_account_batch`, `/2/check/user`, `/2/files/list_folder/continue`, `/2/files/upload_session/start`, `/2/files/upload_session/append`, `/2/files/upload_session/append_v2`. Invariant: every cursor-_minting_ endpoint (`list_folder`, `list_folder/get_latest_cursor`) is path-checked, which is what makes `list_folder/continue` safe.                                                                                                                                                                                                                                                                                                                          |
| B. `host == content.dropboxapi.com`                          | Targets from the `Dropbox-API-Arg` header (must be a valid header string and valid JSON): `/2/files/upload_session/finish` → `commit.path`; `/2/files/upload`, `/2/files/download`, `/2/files/download_zip`, `/2/files/get_preview`, `/2/files/get_thumbnail`, `/2/files/get_thumbnail_v2` → `path`. Any other endpoint → deny `endpoint not permitted: {endpoint}`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| C. any other Dropbox host (in practice `api.dropboxapi.com`) | Body must be present and parse as JSON, else deny `cannot read request body for {endpoint}`. Targets: `/2/files/move_v2`, `/2/files/copy_v2`, `/2/files/move`, `/2/files/copy` → **both** `from_path` and `to_path`; `/2/files/search_v2` → `options.path`; `/2/files/search` → `path`; `/2/files/get_metadata`, `/2/files/list_folder`, `/2/files/list_folder/get_latest_cursor`, `/2/files/create_folder`, `/2/files/create_folder_v2`, `/2/files/delete`, `/2/files/delete_v2`, `/2/files/permanently_delete`, `/2/files/get_temporary_link`, `/2/files/list_revisions`, `/2/files/restore`, `/2/sharing/list_shared_links`, `/2/sharing/create_shared_link_with_settings` → `path`. Any other endpoint (e.g. `/2/files/list_folder/longpoll`) → deny `endpoint not permitted`. |
| D. Per target                                                | Missing / non-string → deny `missing or invalid path for {endpoint}`. Present → `path_allowed` else deny `path outside allowed folders: {p}`. All targets must pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`path_allowed(target, allowed)`:

- target must start with `/` (so `id:…`, `rev:…`, `ns:…` references → not allowed);
- normalize (lowercase, strip trailing `/`); empty (account root) → not allowed;
- allowed iff `norm == entry` or `norm` starts with `entry + "/"` for some entry
  (segment boundary: `/marketing` does not admit `/marketing-2024/x`).

Denial: `rule_name = "Dropbox folder policy"`, `allowed` = the normalized folder list
(e.g. `["/marketing"]`), `reason` = the strings above. Agent sees 403
`resource_access_denied` (§7). Telemetry: a "Blocked" request-log row attributed to the
rule name (emitted by the hook, since the block returns before normal telemetry).

Shape table (provider × request × policy):

| Provider           | Policy                                | Request shape                                                    | Outcome                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dropbox            | `folders` non-empty                   | api host, JSON body, in-scope path                               | allow (credential = stored token, injected normally)                                                                                                                                                                                                                                                                                                                      |
| dropbox            | `folders` non-empty                   | api host, out-of-scope / id: / root / missing path               | 403 `resource_access_denied`                                                                                                                                                                                                                                                                                                                                              |
| dropbox            | `folders` non-empty                   | api host, body absent / non-JSON / **truncated prefix** (>8 MiB) | 403 (cannot read body) — fail-closed                                                                                                                                                                                                                                                                                                                                      |
| dropbox            | `folders` non-empty                   | content host, valid `Dropbox-API-Arg` in scope                   | allow                                                                                                                                                                                                                                                                                                                                                                     |
| dropbox            | `folders` non-empty                   | content host, header missing/invalid JSON                        | 403 (missing or invalid path)                                                                                                                                                                                                                                                                                                                                             |
| dropbox            | `folders` non-empty                   | unknown endpoint on either host                                  | 403 (endpoint not permitted)                                                                                                                                                                                                                                                                                                                                              |
| dropbox            | `folders` non-empty                   | WebSocket upgrade                                                | hook runs with `body = None`; api host would deny, but Dropbox has no WS traffic — effectively N/A                                                                                                                                                                                                                                                                        |
| dropbox            | `folders: ["/"]`                      | anything                                                         | pass-through (unrestricted)                                                                                                                                                                                                                                                                                                                                               |
| dropbox            | `folders: []`                         | anything                                                         | 403 empty-scope (step 3), before the guard; the guard itself also denies (`DenyAll`) if ever reached                                                                                                                                                                                                                                                                     |
| dropbox            | `folders: [42]` (non-empty, no usable string entries) | anything                                             | 403 deny-all (Phase 1 amendment — denies before the pathless allowlist)                                                                                                                                                                                                                                                                                                   |
| dropbox            | `folders: "/clients"` / `folders: null` (key present, not an array) | anything                              | 403 deny-all (Phase 1 amendment — a recognised key in an unusable shape denies, it does not fall back to unrestricted)                                                                                                                                                                                                                                                    |
| dropbox            | `folders: [42, "/valid"]`             | api host, path inside `/valid`                                   | allow — the garbage entry is dropped, not fatal (`Restricted(["/valid"])`)                                                                                                                                                                                                                                                                                                |
| dropbox            | `repositories: [...]` (axis mismatch) | anything                                                         | guard: `folders` absent → pass-through; but connect-time: scoping requested, no scoper for the cred type → shared refresh → not minted → `has_request_guard("dropbox")` is **true** so the stored token is **not** withheld → credential injects unrestricted. (Composition would already have produced `{repositories: []}` if an org boundary existed on another axis.) |
| github-app         | `repositories` non-empty              | any request                                                      | no request-level check; scoped token minted after policy allow; injected                                                                                                                                                                                                                                                                                                  |
| github-app         | `repositories: []`                    | any                                                              | 403 empty-scope before mint                                                                                                                                                                                                                                                                                                                                               |
| github-app         | `folders: [...]` (axis mismatch)      | any                                                              | scoper declines → shared refresh → not scoped → no request guard → **withheld** → 502 `credential_unavailable` (deferred)                                                                                                                                                                                                                                                 |
| github-app         | none                                  | any                                                              | ordinary refresh path, unscoped                                                                                                                                                                                                                                                                                                                                           |
| any other provider | any object policy                     | any                                                              | no guard, no scoper; scoping requested ⇒ withhold (no credential) unless the provider has a request guard                                                                                                                                                                                                                                                                 |
| any                | GraphQL bodies                        | any                                                              | **not inspected by any ee module** (GraphQL discrimination is a free policy-engine concern)                                                                                                                                                                                                                                                                               |

### 1.9 Failure posture

| Error class                                     | Posture                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Unparseable / missing body or header on Dropbox | Fail-**closed** (403)                                                           |
| Truncated body buffer                           | Fail-closed: the forward path hands the guard `None` for a truncated buffer (Phase 1 WP-C item E), not the observed prefix, so the guard's own "cannot read request body" denial fires unconditionally rather than depending on whether the prefix happens to still parse |
| Unknown Dropbox endpoint                        | Fail-closed                                                                     |
| GitHub mint upstream error / incomplete creds   | Credential withheld → 502 `credential_unavailable` (deferred) — fail-closed     |
| Policy on unrecognised axis for the provider    | Deny-all sentinel on composition; at mint time, withheld unless request-guarded |
| No policy                                       | Pass-through (unrestricted)                                                     |

### 1.10 Caching

None inside the module. Upstream state: composed policy lives in `ConnectResponse`
(60 s TTL, key `connect:{org}:{workspace}:{agent_token}:{hostname}`) and in the
`app_injection:` rule cache (key includes the policy; TTL ≤ 60 s and ≤ token lifetime).
Scoped tokens are never persisted.

### 1.11 Limits / constants

- Dropbox endpoint tables above; `RULE_NAME = "Dropbox folder policy"`.
- GitHub JWT: `iat-60`, `exp+600`; API version `2022-11-28`.
- Body buffer cap (free): 8 MiB default.

### 1.12 Edge cases pinned by tests

Unit: sorted+deduped intersection; nested folder pair keeps the deeper one from either
side; root boundary; `/clientsfoo` not inside `/clients`; move requires both sides;
`search_v2` without `options.path` denied; `get_latest_cursor` path-checked; `""` and
`id:` refused; unknown endpoint and missing body denied; account-info and `continue`
allowed; policy `["/Clients/Acme/", "/Marketing", "/"]` normalizes to `[/clients/acme,
/marketing]`; GitHub coverage exact + case-insensitive; empty-list scoper refuses.

E2E (`resource-boundary.test.ts`, licensed default lane): disjoint org boundary vs
workspace pick → 403 `resource_access_denied` with `allowed: []` and message containing
"do not overlap"; pick inside boundary → falls through to the block rule
(`blocked_by_policy`); plain org attach cannot evict a boundary; boundary `[]` bounds a
workspace-only grant → empty scope; `grant({repositories: []})` → empty scope;
provider-level grant bounded; unnamed org boundary never grants (unattached connection →
ordinary policy block). `unlicensed.test.ts` twin: same seeds unlicensed → credential
injects unscoped and the block rule answers.

### 1.13 Fork relevance

**KEEP** entirely (GitHub token scoping, Dropbox guard, composition, `denies_everything`,
`has_request_guard`/`has_token_scoper`); drop the `entitled` parameter at the stamping
call site (always stamp).

---

## 2. `principals` (+ `resolve`, `availability`)

### 2.1 Purpose

Connect-time (cached ~60 s) resolution of (a) a workspace's **principal set** for
policy identity matching and (b) the workspace's **available app providers** when the
org is in restricted availability mode. Both share one org-fenced CTE.

### 2.2 Inputs / outputs

Inputs: `workspace_id` ($1), `organization_id` ($2), PgPool. Outputs:
`PrincipalSet { user_ids, group_ids }`; `AvailableApps { restricted: bool, providers: Vec<String> }`.

Tables read: `workspace_access`, `groups`, `group_members`, `organization_members`,
`app_availability_rules`, `app_availability_rule_identities`, `organizations`.

### 2.3 The principal CTE, in words

1. `direct_groups`: group ids from `workspace_access` rows of the workspace with a non-null
   `group_id`, **joined to `groups` and fenced to `groups.organization_id = org`** (a stray
   cross-org grant cannot leak in).
2. `candidate_users`: UNION of (i) `workspace_access.user_id` for the workspace where
   non-null, and (ii) `group_members.user_id` for every group in `direct_groups`.
3. `all_users`: candidates INNER-JOINed to `organization_members` on user id **and**
   `organization_id = org` **and** `status <> 'suspended'`. Role is ignored. This join is
   the org fence for users (a user whose only active membership is a foreign org is
   dropped even with a direct grant) and the liveness filter (suspended out; a missing
   membership row = removed = out).
4. `all_groups`: UNION of `direct_groups` and every group (fenced to `groups.organization_id
= org`) that any `all_users` member belongs to via `group_members`.

`find_principal_set` returns `all_users` as user ids and `all_groups` as group ids. Any DB
error propagates (see §2.6).

Free twin `find_direct_user_principals` (policy-engine, unlicensed arm): DISTINCT
`workspace_access.user_id` for the workspace, non-null, joined to `organization_members`
with the same org fence and the same `status <> 'suspended'` predicate. The DB parity
tests pin: (a) licensed = `{direct, viagroup}` users + `{grp}` group, free = `{direct}`;
(b) in a direct-only world the two user lists are identical and licensed groups are empty.
The liveness predicate is deliberately `<> 'suspended'`, **not** `= 'active'`.

### 2.4 When it runs

Only when some loaded published v2 rule (org or workspace scope) carries a **user**
identity, or (when entitled) a **group** identity. Agent-only / unnamed rules skip the
query. Cached with `PolicyV2Rules` inside `ConnectResponse` (60 s). Never on the
per-request path.

### 2.5 Availability (`load_available_apps`, `app_availability_block`)

Load (connect time):

| Step                                                             | Rule                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read `organizations.app_availability_mode` for the org (LIMIT 1) | missing row → `"open"`                                                                                                                                                                                                                                                                                                               |
| mode ≠ `"restricted"` (i.e. `"open"` or anything else)           | return default `{restricted: false, providers: []}`                                                                                                                                                                                                                                                                                  |
| DB error reading mode                                            | warn; return default (fail-**open**)                                                                                                                                                                                                                                                                                                 |
| mode == `"restricted"`                                           | run the CTE + `matching_rules`: DISTINCT rules in `app_availability_rules` with `organization_id = org` joined to `app_availability_rule_identities` where `user_id ∈ all_users` OR `group_id ∈ all_groups`; then DISTINCT non-null elements of each matching rule's `providers` text array. Return `{restricted: true, providers}`. |
| DB error in provider resolution                                  | warn; return default (fail-open this cycle)                                                                                                                                                                                                                                                                                          |

Semantics: a rule with `providers = []` grants nothing; a restricted org with no
matching rule blocks every identifiable provider for that workspace; a person matching
several rules gets the union.

Block (per request, pure):

| Condition                                                                                                                                                   | Result                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `!restricted`                                                                                                                                               | allow                                    |
| host (port-stripped, lowercased) + path identify a provider via `provider_for_host_and_path` and that provider ∉ `providers`                                | `Some(provider)` → 403 `app_unavailable` |
| provider identified and granted                                                                                                                             | allow                                    |
| no provider identified: raw/unknown host, LLM hosts (`api.openai.com`, `api.anthropic.com`), shared host (`www.googleapis.com`) with an unknown path prefix | allow (structural fail-open)             |
| shared host with known prefix (`/gmail/…` vs `/calendar/…`)                                                                                                 | decided per path-scoped provider         |

The block matches on `policy_host` (pre-rewrite) and runs for HTTP and WebSocket, before
policy evaluation.

### 2.6 Failure posture

| Class                               | Posture                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Principal CTE DB error              | Propagates → the whole CONNECT resolution fails (`db_err`) → agent gets a connect error and retries; nothing cached. Fail-closed by refusal (deliberate: resolving empty would allow-all AND strip credentials for 60 s). |
| Availability mode/provider DB error | Fail-open (unrestricted)                                                                                                                                                                                                  |
| Unknown `kind` row from CTE         | warn, skip                                                                                                                                                                                                                |

### 2.7 Caching

Both results live in `ConnectResponse` (TTL 60 s, keyed by org/workspace/agent
token/host). Invalidation: TTL expiry, or the free cache-invalidation paths (prefix
delete on `connect:`) triggered by the control API. No dedicated cache.

### 2.8 Limits / constants

None beyond the 60 s connect TTL.

### 2.9 Edge cases pinned by tests

Unit: open allows everything; restricted blocks ungranted (`gmail`, `github`), allows
granted; restricted + empty list never blocks `api.openai.com`, `api.anthropic.com`,
`example.com`; `www.googleapis.com` disambiguates by path and unknown path fails open;
port `:443` stripped; mixed-case host lowercased. DB: parity tests above. E2E
(`control.test.ts` "app availability"): restricted + block rule → 403 `app_unavailable`
with `provider: "gmail"`, `host: "gmail.googleapis.com"`, `x-should-retry: false`; open
→ `blocked_by_policy`. `policy.test.ts` "rule identities": org rule bound to an
inherited user → 403; bound to a granted group → 403; bound to another agent → 200.
`unlicensed.test.ts`: group rule and user-via-group rule stop firing unlicensed; direct
user still fires; restricted availability ignored unlicensed.

### 2.10 Fork relevance

**KEEP** `find_principal_set` (always used; `find_direct_user_principals` becomes dead in
the fork but the parity test is a useful pin) and app availability if the fork exposes
the admin surface; otherwise TRIM availability to the "open" default. Group principals and
workspace access are explicitly wanted.

---

## 3. `rbac`

### 3.1 Purpose

The licensed ROLE half of API-key authentication: after the free LIVENESS gates, re-check
that an org key's user is still admin/owner and a workspace key's user still has
workspace access. Installed as the `RoleResolver` at startup.

### 3.2 Inputs / outputs / when

| Key kind           | Free liveness gate (always)                                                           | Licensed role recheck (resolver installed)                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oc_org_*`         | user has an `organization_members` row for the key's org with `status <> 'suspended'` | `user_is_org_admin`: same row also has `role IN ('owner','admin')`                                                                                                                                                                                                      |
| `oc_*` (workspace) | user has a non-suspended membership in the workspace's org                            | `user_can_manage_workspace`: non-suspended membership in the workspace's org AND (role owner/admin OR a `workspace_access` row for that workspace with `user_id = user` OR a `workspace_access` row with a `group_id` that the user is a member of via `group_members`) |

Runs **per request** on every `oc_` bearer (no caching; two extra queries per API-key
request in the licensed arm). Sessions (cookie / Cognito) never consult the resolver.
`created_by_user_id` on workspaces is **not** consulted (pure provenance).

Free-side flow to preserve (`context::auth::validate_api_key`): an `oc_` bearer commits
the request to key auth (no session fallthrough). Order for org keys: lookup key → liveness
→ role → optional `X-Workspace-Id` (blank = absent; legacy `X-Project-Id` alias fills
absence) verified to belong to the org. Workspace keys: lookup → liveness → role.

### 3.3 Failure posture

Every failure — unknown key, DB error in any check, failed liveness, failed role — is the
same uniform **401 "invalid API key"**; the specific cause is logged only. Fail-closed.

### 3.4 Caching

None.

### 3.5 Edge cases pinned by DB tests (`s14a`–`s14k`)

Direct binding → allowed; group binding → allowed; org admin without binding → allowed;
active member without binding → denied; suspended member with binding → denied (suspension
beats binding); removed creator (no membership row, `created_by_user_id` set) → denied;
binding deleted → denied immediately; active creator with seeded `owner` binding → allowed
(usage is role-blind); binding without active membership → denied; binding on sibling
workspace → denied; org recheck: owner/admin true, member false, suspended admin false,
non-member false.

E2E (`unlicensed.test.ts`): a demoted (member) org key reaches the org feed's license 403
unlicensed (recheck stood down); licensed the same key dies 401. Fork note: under
always-entitled the first scenario inverts (member org key → 401).

### 3.6 Fork relevance

**KEEP**, always installed (`enforce_key_rechecks` collapses to true).

---

## 4. `budget` (+ `binding`, `spend`, `meter`, `anthropic`, `pricing`)

### 4.1 Purpose

Per-(secret, subject) spend caps on LLM keys. Resolve bindings at connect time; gate each
request (`spend >= limit` → 403); meter 2xx responses (Anthropic SSE/JSON) into
nano-dollars; persist spend via a hot counter plus a durable Postgres floor.

Upstream status: **DORMANT** for org budgets — eligibility is keyed on secret scope
`"partner"`, which nothing produces any more; only the platform trial credit (§8.1)
synthesizes a binding in practice. Everything downstream is live and tested.

### 4.2 Types

| Type            | Values                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BudgetPeriod`  | `Monthly` (resets on the 1st, UTC) \| `Total` (lifetime) — serde snake_case                                                                                                                                                                         |
| `BudgetSubject` | `Org(id)` rendered `org:<id>`; `User(id)` rendered `user:<id>`. Serde round-trips through that string; an **unprefixed** string fails to parse (a stale cached `ConnectResponse` then reads as a cache miss → re-resolve, never wrong enforcement). |
| `BudgetBinding` | `secret_id`, `subject`, `secret_type` (selects the meter), `limit_nanos` (i64, 1e-9 USD), `period`                                                                                                                                                  |

Nano-dollar constants: 1 cent = 10,000,000 nanos; $1 = 1e9 nanos.

### 4.3 Binding resolution (`resolve_bindings(pool, org_id, host-filtered secrets, entitled)`)

| Step | Rule                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `!entitled` → `[]` (removes the per-request DB touch entirely)                                                                                                                                                                                                                                                                                                      |
| 1    | **Effective eligible secrets**: those with `scope == "partner"` (`BUDGET_ELIGIBLE_SCOPE`) that are **not shadowed** by any secret in the same list with a different scope and the **same `type`** (shadowing is by type, not path: two same-type keys collide on the same auth header; disjoint-path configs are conservatively treated as shadowed). Empty → `[]`. |
| 2    | Query `budgets` where `organization_id = org` and `secret_id = ANY(effective ids)` selecting `secret_id, limit_cents, period`. DB error → warn, `[]` (fail-open).                                                                                                                                                                                                   |
| 3    | Per row: `limit_cents <= 0` → warn and skip (never a permanent block); `period == "total"` → Total, anything else → Monthly; `limit_nanos = limit_cents × 1e7`; `subject = Org(org_id)`; `secret_type` from the effective secret.                                                                                                                                   |

Pinned: partner unshadowed → 1 binding; partner + org secret of same type → none; partner +
org secret of different type → 1; org/workspace-scoped secrets are never candidates. DB
differential: same seeded budget resolves licensed, not unlicensed.

Fork design note (not upstream behaviour): to budget ordinary org/workspace secrets the
eligibility predicate and the shadowing rule must be redefined (e.g. eligible = the
secret(s) actually injected for the host, with workspace shadowing org by type). The API
side (`budget-service.ts`) must agree or budgets set there never bind.

### 4.4 Spend accounting (`spend`)

Keys and windows:

| Item                  | Value                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `period_key(Monthly)` | `m:YYYY-MM` (UTC now)                                                                                                                                                                                             |
| `period_key(Total)`   | `total`                                                                                                                                                                                                           |
| cache key             | `budget:spend:{secret_id}:{subject rendered}:{period_key}` (one format string for read and write) — e.g. `budget:spend:platform:anthropic:user:u1:total`                                                          |
| TTL monthly           | `(days_in_month − today + 1) × 86400` (through end of UTC month)                                                                                                                                                  |
| TTL total             | 90 days (`TOTAL_TTL_SECS`), rebuilt from the floor on expiry                                                                                                                                                      |
| durable floor         | `budget_spends(secret_id, organization_id, period, spent_nanos, updated_at)` with PK `(secret_id, organization_id, period)`; `organization_id` holds the **rendered subject** (`org:…`/`user:…`) despite its name |

`read_spent_nanos(binding)`: `get_raw(key)` → parse i64 (unparseable → 0). On a **miss**:
read the floor row (`spent_nanos` where secret/subject/period match; DB error or no row →
0), then `set_raw(key, floor, ttl)` and return floor. **Clobber window**: if a flush-time
`incrby` lands between the floor read and the `set_raw`, the set overwrites it —
under-counts by at most one flush batch until the next miss/rollover (accepted;
`SET NX` would tighten it).

`is_over_budget` = `read_spent_nanos >= limit_nanos` (inclusive: exactly-at-limit blocks;
e2e seeds exactly $5 and expects the block).

`add_spend(secret_id, subject, period_key, nanos)` (off the hot path, from the telemetry
flush): `nanos <= 0` → return. Then (1) atomic `incrby(key, nanos, ttl)` — TTL is set
only when the key is new; failure → warn only; (2) UPSERT into `budget_spends` adding
`nanos` to `spent_nanos` on conflict, `updated_at = NOW()`; failure → warn only. Order:
**hot counter first, then durable insert**. Neither failure blocks anything.

Flush aggregation (free telemetry crate, must be preserved): per batch, sum `cost_nanos`
per `(secret_id, subject, period_key)`, dropping non-positive charges; call the installed
`SpendSink` per key with bounded concurrency. Charges ride the bounded telemetry channel
(`try_send`) — under backpressure a charge can drop (soft undercount). The sink is
installed unconditionally at startup; a missing sink logs "charges dropped".

### 4.5 Enforcement and metering hooks (free-side `proxy::hooks`, contract)

- `prepare_request`: if any binding's `secret_type` `has_meter` → remove `Accept-Encoding`
  (so non-streaming JSON arrives identity-encoded).
- `pre_forward`: after the granular guard and **before** the plan quota, for **every**
  binding in order: `is_over_budget` → warn, emit "Blocked" telemetry with rule name
  `budget_exceeded`, return `response::budget_exceeded(binding, workspace_id)`.
- `track_and_wrap`: only for 2xx; picks the **first** binding with a meter (at most one
  effective budgeted credential per host in practice); `is_sse` = response `Content-Type`
  contains `text/event-stream`; wraps the stream. Non-2xx → no charge, normal telemetry.

### 4.6 Meter (`meter`, `anthropic`)

`has_meter(secret_type)` = `secret_type == "anthropic"`. Other types: stream passes
through and the telemetry event fires immediately with no charge (the gate still enforced
prior spend).

`MeteringStream`: feeds every chunk to the accumulator, passes bytes through unchanged;
at stream end (`None`) **or on drop** (client disconnect / abort) fires **exactly once**:
`cost = acc.finish()`, emits the request event with `BudgetCharge{secret_id, subject,
period_key, cost_nanos}`. Errors mid-stream are passed through; the charge still fires on
drop for what was parsed.

SSE accumulator:

- Append chunk to a line buffer; for each complete `\n`-terminated line (strip trailing
  `\r`), if it starts with `data:` parse the trimmed remainder as JSON (parse failure →
  ignore the line).
- `type == "message_start"`: `message.model` → model; `message.usage.input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens` → set (overwrite).
- `type == "message_delta"`: `usage.output_tokens` → set only if `> 0` (last positive wins).
- Other event types ignored.
- If the unterminated remainder exceeds **512 KiB** (`MAX_SSE_LINE_BYTES`) → warn and
  discard it (undercount at most one event; bounds memory).
- `finish` → `cost_nanos(usage)`.

JSON accumulator:

- Buffer up to **256 KiB** (`MAX_JSON_BYTES`); exceeding → mark truncated, drop buffer,
  ignore further chunks; `finish` → warn, **$0**.
- `finish`: parse whole body; failure → warn, $0. Model = top-level `model` string;
  usage = top-level `usage` object with the four token fields (missing → 0).

Pricing (`pricing`), nano-dollars per token; model matched by **substring** of the wire
model id (date suffixes tolerated):

| Family (substring)      | input             | output | cache write (5-min tier) | cache read |
| ----------------------- | ----------------- | ------ | ------------------------ | ---------- |
| `opus`                  | 5,000             | 25,000 | 6,250                    | 500        |
| `sonnet`                | 3,000             | 15,000 | 3,750                    | 300        |
| `haiku`                 | 1,000             | 5,000  | 1,250                    | 100        |
| unknown / missing model | Opus rates (warn) |        |                          |            |

Equivalent to $/MTok: Opus 5/25/6.25/0.5; Sonnet 3/15/3.75/0.3; Haiku 1/5/1.25/0.1. The
1-hour cache-write tier (2× input) is lumped into `cache_creation_input_tokens` and
therefore undercharged (documented, accepted).

`cost_nanos`: if all four token counts are 0 → **0 with no warning and no rate lookup**
(models-list / count_tokens bodies); else saturating multiply-add; clamp to `i64::MAX`.
Pinned: Opus 1000 in + 100 out = 7,500,000; Sonnet same = 4,500,000; Opus 1000 cache write

- 1000 cache read = 6,750,000; unknown model == Opus; missing model with any single token
  class > 0 charges Opus and warns once.

### 4.7 Agent-facing response

`response::budget_exceeded` — **403** (not 402; upstream deliberately uses 403 uniform
with other policy blocks; the JSON `error` disambiguates), `x-should-retry: false`; see §7.

### 4.8 Failure posture summary

| Class                                  | Posture                                           |
| -------------------------------------- | ------------------------------------------------- |
| `budgets` query error                  | fail-open (no bindings)                           |
| cache read error / miss                | rehydrate from floor; floor error → 0 (fail-open) |
| cache incr error / floor upsert error  | logged; request unaffected                        |
| oversized or unparseable response body | charge $0 (undercount)                            |
| unknown model                          | overcharge at Opus (fail-safe toward enforcement) |
| telemetry channel full                 | charge dropped (undercount)                       |

### 4.9 Fork relevance

**KEEP** spend/meter/pricing/response as-is; **REWRITE** `binding.rs` eligibility for
org/workspace secrets (design decision needed, see §4.3 note); drop the `entitled`
parameter; drop the platform-credit arm. The cache store will be the in-memory one
(`incrby` sets TTL on first insert or after expiry; get/set semantics identical).

---

## 5. `ha` (+ `approval`, `cache`) — behaviour contract only

### 5.1 Purpose

Redis-backed `CacheStore` and `ApprovalStore` for multi-instance deployments, plus the
startup entitlement check and Redis URL assembly. The fork drops these; the in-memory
stores (free crates `cache`, `approval`) must keep satisfying the same trait contract.

### 5.2 Startup

`check_ha_entitlement(redis_host, entitled)`: entitled → Ok. Otherwise a `REDIS_HOST` that
is present and non-blank after trim → error whose display contains "Enterprise license".
Blank/whitespace counts as unset. Store selection (`wiring`): non-blank `REDIS_HOST` →
Redis stores, else in-memory. Fork: no Redis; the check becomes moot (or: refuse Redis
config outright since HA is unsupported).

`redis_url_from_env`: `REDIS_HOST` (default `localhost`), `REDIS_PORT` (default `6379`),
scheme `rediss://` unless `REDIS_TLS=false` (exact string), `REDIS_PASSWORD` percent-encoded
(NON_ALPHANUMERIC) as `default:{pw}@`.

### 5.3 Cache store contract (what in-memory must keep doing)

| Op                           | Redis behaviour                                                                                | In-memory equivalent (existing)                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `get_raw`                    | GET; error → warn, treat as miss                                                               | lazy-expire on read                                                                      |
| `set_raw(k, v, ttl)`         | SETEX; error → warn (not cached)                                                               | insert with expiry (overflow-safe: ~1 year cap)                                          |
| `del`                        | DEL                                                                                            | remove                                                                                   |
| `del_by_prefix`              | SCAN MATCH `{prefix}*` COUNT 100 loop + DEL batches; SCAN error → stop                         | retain keys not starting with prefix                                                     |
| `incr` / `incrby(k, n, ttl)` | Lua: EXISTS → INCRBY → EXPIRE only if the key did not exist; returns new count; error → `None` | entry-or-insert "0" with expiry; if expired reset to 0 and re-arm TTL; add; return count |

Consumers: connect cache (`connect:` keys, 60 s), app injection cache, policy rate-limit
counters, spend counters (§4.4), free-plan quota (`api:quota:injection-calls:{org}:{YYYY-MM}`).

### 5.4 Approval store contract

Shared types: `PendingApproval{id, organization_id, workspace_id (serde alias
project_id), agent_id, agent_name, agent_identifier, method, scheme, host, path,
headers, body_preview, summary, created_at, expires_at}`; `APPROVAL_TIMEOUT_SECS = 180`;
`DecisionOutcome{decision: Approve|Deny, approved_by: Option<String>}`.

| Method                                                                  | Contract                                                                                                                                   | Redis mechanics (dropped by fork)                                                                                                                                                                                                                                                                                                           | In-memory (kept)                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `prepare_wait(org, ws, id)`                                             | Must be called **before** `store` (race: SDK may decide before the gateway listens). Returns a waiter.                                     | BLPOP on `approval:decision:{org}:{ws}:{id}` over a **dedicated** connection (response timeout = wait + 10 s, connect timeout 5 s, BLPOP timeout ≥ 1 s). Payload JSON `DecisionOutcome`, with legacy fallback for bare `approve`/`deny` strings (→ `approved_by: None`); other → `None`. Timeout/connection failure → `None` (= auto-deny). | watch channel per id; returns immediately if already decided; sender dropped → `None`. |
| `store(approval)`                                                       | Persist, index per workspace and per org, notify long-pollers on both channels. `Err` → caller fails the request (502) instead of hanging. | SETEX `approval:{org}:{ws}:{id}` TTL **190 s**; SADD `approvals:{org}:{ws}` + EXPIRE 190; PUBLISH `approval:new:{org}:{ws}`; SADD `approvals:{org}` member `{ws}:{id}` + EXPIRE 190; PUBLISH `approval:new:{org}`. Only the SETEX failure is an error.                                                                                      | insert; broadcast on `{org}:{ws}` and on `{org}` keys.                                 |
| `get_pending`                                                           | Return only if `expires_at > now`.                                                                                                         | GET + decode; expired → None (key left to TTL)                                                                                                                                                                                                                                                                                              | expired → remove + None                                                                |
| `list_pending(org, ws)`                                                 | Non-expired approvals of the workspace.                                                                                                    | SMEMBERS + MGET; decode failures skipped; filter expiry; errors → empty                                                                                                                                                                                                                                                                     | filter by workspace + expiry                                                           |
| `list_pending_for_org(org)`                                             | Non-expired approvals across all workspaces of the org.                                                                                    | SMEMBERS `approvals:{org}` → rebuild data keys from `{ws}:{id}` → MGET; errors → empty                                                                                                                                                                                                                                                      | filter by org + expiry                                                                 |
| `remove(org, ws, id)`                                                   | Drop the approval, its indexes and its decision channel.                                                                                   | SREM both sets, DEL data key, DEL decision key                                                                                                                                                                                                                                                                                              | remove pending + decision sender                                                       |
| `wait_for_new(org, ws, timeout)` / `wait_for_new_for_org(org, timeout)` | Block until a new approval is stored in scope or timeout; true iff notified.                                                               | Opens a **fresh** client from env per call, SUBSCRIBE `approval:new:{org}:{ws}` / `approval:new:{org}`, wait one message; any setup failure → false                                                                                                                                                                                         | subscribe to broadcast (capacity 16), timeout → false                                  |
| `submit_decision(org, ws, id, decision, approved_by)`                   | Deliver to the waiter, then remove. Returns whether delivered.                                                                             | LPUSH JSON outcome to the decision key (error → false), EXPIRE 190, then `remove`; returns true even if no BLPOP is listening (the key holds the value until TTL)                                                                                                                                                                           | true only if a decision sender exists; sends, removes pending                          |

In-memory-only extras that must remain: a 30 s cleanup task auto-**denies** expired
approvals (`approved_by: None`) and prunes notify channels; `ApprovalGuard` removes an
approval when the held request future is dropped and stamps `approval_cancelled` on the
request log.

### 5.5 Failure posture

Redis: every operation fails soft (warn + empty/None/false) except `store` (SETEX) and
URL/connection setup at boot. Cross-instance visibility is bounded by the 190 s TTL.

### 5.6 Fork relevance

**DROP** the Redis implementations and env parsing. Keep the trait contract above intact
for the in-memory stores (they already satisfy it). Decide whether a configured
`REDIS_HOST` should be ignored or refused.

---

## 6. `org_routes` — `GET /v1/org/approvals/pending`

| Aspect           | Contract                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mount            | Always mounted on the axum router (`mount(router)`), every edition.                                                                                                                                                                                                                                                                                                  |
| Auth             | `OrgAuthUser` extractor: an `oc_` bearer commits to API-key auth (401 on any failure, incl. role recheck); otherwise session auth (workspace optional, org scope **never** available to a session).                                                                                                                                                                  |
| Gate 1           | `!entitled()` → **403** `{"error":"enterprise_license_required"}`. Evaluated _after_ auth (so a member's org key reaching this 403 proves the role recheck stood down — pinned by e2e). Fork: this branch disappears.                                                                                                                                                |
| Gate 2           | `organization_id` absent (workspace key, or any session) → **403** `{"error":"organization_scope_required"}`.                                                                                                                                                                                                                                                        |
| Query            | `exclude` = comma-separated approval ids to ignore (trimmed, empties dropped).                                                                                                                                                                                                                                                                                       |
| Body             | `list_pending_for_org(org)` minus excluded. If empty → long-poll `wait_for_new_for_org(org, 30 s)`, racing the shutdown signal (shutdown → stop waiting, answer what we have). If notified → re-list and re-filter.                                                                                                                                                  |
| Response         | 200 `{"requests":[row…],"timeoutSeconds":180}`. Row = shared `pending_approval_row`: `id, workspaceId, method, url ("{scheme}://{host}{path}"), host, path, headers, bodyPreview, summary, agent{id,name,externalId}, createdAt (RFC3339), expiresAt (RFC3339)` plus the legacy dual-emitted `projectId` (= workspaceId). Byte-identical to the workspace poll rows. |
| Decision routing | Not here — the SDK decides via the existing `/v1/approvals/{id}/decision` with the row's workspace id (header `X-Workspace-Id`, legacy `X-Project-Id` accepted).                                                                                                                                                                                                     |

Pinned by e2e (`approval.test.ts`): an org key sees the held approval with
`workspaceId`/`projectId` = the workspace and can approve it with the legacy header;
`unlicensed.test.ts`: 403 license body (unlicensed) and 401 for a demoted org key (licensed).

Fork relevance: **KEEP** minus Gate 1.

---

## 7. `response` — every agent-facing body the ee crate produces

All five: JSON body, `content-type: application/json`, header `x-should-retry: false`.
Dashboard base URL comes from the configured external URL (`ONECLI_EXTERNAL_URL` /
legacy `APP_URL`, fallback constant).

| Builder                                                    | Status  | `error`                  | Other fields                                                                                                                      | `message` (verbatim shape)                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quota_exceeded(limit, org_id)`                            | **429** | `quota_exceeded`         | `limit`, `upgrade_url` = `{base}/org/{oid}/billing` or `{base}/billing`                                                           | "Your plan allows {limit} integration calls per month. Upgrade to Pro or Team for unlimited calls." (Cloud free plan only; limit 500)                                                                                       |
| `budget_exceeded(binding, workspace_id)` (org budget)      | **403** | `budget_exceeded`        | `limit_usd` (f64 = nanos/1e9), `period` (`monthly`\|`total`), `add_key_url` = `{base}/w/{workspace}/connections/llms` or `{base}` | "This organization's spend budget for the {secret_type} key (${limit:.2} this month\|in total) has been reached, so the key is paused. The user can set their own key in the OneCLI dashboard to keep going: {add_key_url}" |
| `budget_exceeded` when `secret_id == "platform:anthropic"` | **403** | `trial_credit_exhausted` | same                                                                                                                              | "Your free OneCLI trial credit (${limit:.2}) is used up. Add your own Anthropic API key in the OneCLI dashboard to keep going: {add_key_url}"                                                                               |
| `app_unavailable(provider, method, path, host)`            | **403** | `app_unavailable`        | `provider`, `method`, `host` (port-stripped), `path`                                                                              | "The \"{provider}\" app is not available to this workspace. {method} {host}{path} was blocked. An organization admin can grant access on the App Availability page."                                                        |
| `forbidden_resource(reason, allowed)`                      | **403** | `resource_access_denied` | `allowed` (array), `detail` = reason                                                                                              | "This agent is restricted to: {allowed joined by ", "}. The requested resource is outside its allowed scope — use a location inside one of those."                                                                          |
| `forbidden_empty_scope()`                                  | **403** | `resource_access_denied` | `allowed: []`, `detail: "empty resource scope"`                                                                                   | "This agent's resource scope is empty: the organization's allowed resources and this workspace's selection do not overlap, so the credential can reach nothing. Ask an administrator to widen the scope."                   |

Pinned: budget is 403 not 402; the two budget codes are distinct (downstream classifiers
key on `trial_credit_exhausted`); empty-scope message contains "do not overlap"; quota is
429 not 403. No `x-onecli-*` headers are set by this crate (the `x-onecli-connections`
header seen in e2e is the free policy 403's).

Fork relevance: KEEP `budget_exceeded` (org arm), `app_unavailable` (if availability kept),
`forbidden_resource`, `forbidden_empty_scope`; DROP `quota_exceeded` and the trial-credit arm.

---

## 8. Cloud-only modules

### 8.1 `platform_llm` — platform Anthropic trial credit (DROP)

Cloud-only by code: `parse` returns nothing unless `Edition::Cloud`. Config:
`PLATFORM_ANTHROPIC_API_KEY` must be non-blank and start with `sk-ant-` (a generated
placeholder must never inject); `PLATFORM_ANTHROPIC_CREDIT_CENTS` default 500 ($5),
non-numeric → default with warn, `<= 0` → feature disabled; `PLATFORM_ANTHROPIC_API_HOST`
override (trimmed, lowercased; blank → `api.anthropic.com`). Read once. Applies when the
CONNECT host equals the configured host, the deployment is entitled, and the unfiltered
org+workspace secret pool has **no** LLM credential (`type` anthropic/openai, or any
`host_pattern` that is an LLM host — an OpenAI key or a key not granted to the agent still
disqualifies). Injects the standard Anthropic header shape with `path_pattern: "*"` and
synthesizes `BudgetBinding{secret_id: "platform:anthropic", subject: earliest active
owner of the org ordered by created_at then user_id → User(id); none/DB error → Org(id),
secret_type: "anthropic", limit: credit, period: Total}`. Spend rows key on
`(platform:anthropic, user:<id>, total)` so a second org by the same owner shares the
exhausted pool. E2E (`platform-llm.test.ts`) runs the `EDITION=cloud` lane. Confirmed
cloud-only; no self-host path reaches it.

### 8.2 `cognito` — Cognito session validation (DROP)

Hosted-platform plumbing, not entitlement-gated; selected only when `EDITION=cloud` and
`COGNITO_USER_POOL_ID` is non-blank (`configured()`), otherwise the self-hosted
session-cookie validator stays. Mechanics: bearer JWT → decode header `kid` → JWKS cache
keyed by kid from
`https://cognito-idp.{AWS_REGION|us-east-1}.amazonaws.com/{pool}/.well-known/jwks.json`,
refresh at most every 300 s (unknown kid inside the window → "unknown signing key"), RSA
signing keys only; RS256 with `exp` validated and `aud` **not** validated; `sub` →
`users.external_auth_id` → internal user id. Errors: non-JWT tokens fall through as
"invalid token" (debug), DB error "internal error", unknown user "user not found".
Confirmed cloud-only by code.

### 8.3 `kms_crypto` — KMS envelope backend (DROP)

Hosted-platform plumbing; selected by config only when `SECRET_ENCRYPTION_KEY` is unset
(every supported self-host sets it). Wire format `{edk_b64}:{iv_b64}:{tag_b64}:{ct_b64}`
compatible with the TypeScript `KmsCryptoService`; decrypt = KMS Decrypt of the data key
(encryption context `purpose=onecli-secret-encryption`) then AES-256-GCM with the shared
primitives, data key zeroed after; encrypt = KMS GenerateDataKey (AES_256) under
`KMS_KEY_ARN` (read at encrypt time; missing → error) then seal. A committed fixture pins
the TS↔Rust contract. Confirmed dead on self-host by config.

---

## 9. Environment variables read by the ee crate

| Variable                                     | Module                                                 | Effect                                                   | Fork                                    |
| -------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------- |
| `REDIS_HOST`                                 | `ha` (and free `cache::redis_host_configured`, `main`) | Non-blank selects Redis stores; unlicensed → refuse boot | DROP                                    |
| `REDIS_PORT`                                 | `ha`                                                   | default `6379`                                           | DROP                                    |
| `REDIS_TLS`                                  | `ha`                                                   | `false` → `redis://`, else `rediss://`                   | DROP                                    |
| `REDIS_PASSWORD`                             | `ha`                                                   | percent-encoded userinfo                                 | DROP                                    |
| `KMS_KEY_ARN`                                | `kms_crypto`                                           | key for GenerateDataKey (encrypt time)                   | DROP                                    |
| `AWS_REGION`                                 | `cognito`                                              | JWKS URL region (default `us-east-1`)                    | DROP                                    |
| `COGNITO_USER_POOL_ID`                       | `cognito`                                              | presence half of the Cognito selector                    | DROP                                    |
| `PLATFORM_ANTHROPIC_API_KEY`                 | `platform_llm`                                         | trial credit key (`sk-ant-` shape)                       | DROP                                    |
| `PLATFORM_ANTHROPIC_CREDIT_CENTS`            | `platform_llm`                                         | lifetime credit, default 500                             | DROP                                    |
| `PLATFORM_ANTHROPIC_API_HOST`                | `platform_llm`                                         | host override (tests)                                    | DROP                                    |
| `GATEWAY_TEST_DATABASE_URL`, `CI`            | test modules only                                      | DB test gating; CI asserts the URL is set                | keep for tests                          |
| (indirect) `EDITION`, `ENTERPRISE_ENABLED`   | free `common::edition`, consulted by ee gates          | edition / entitlement                                    | `ENTERPRISE_ENABLED` becomes irrelevant |
| (indirect) `ONECLI_EXTERNAL_URL` / `APP_URL` | free `context::dashboard_url()` used by `response`     | deep links in 403/429 bodies                             | keep                                    |

## 10. Database tables/columns touched by the ee crate

| Table                              | Columns                                                                                  | Access          | Module                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | --------------- | ------------------------------ |
| `workspace_access`                 | `workspace_id`, `user_id`, `group_id`                                                    | read            | principals, rbac               |
| `groups`                           | `id`, `organization_id`                                                                  | read            | principals                     |
| `group_members`                    | `group_id`, `user_id`                                                                    | read            | principals, rbac               |
| `organization_members`             | `user_id`, `organization_id`, `status`, `role`, `created_at`                             | read            | principals, rbac, platform_llm |
| `workspaces`                       | `id`, `organization_id`                                                                  | read            | rbac                           |
| `organizations`                    | `id`, `app_availability_mode`                                                            | read            | principals                     |
| `app_availability_rules`           | `id`, `organization_id`, `providers` (text[])                                            | read            | principals                     |
| `app_availability_rule_identities` | `rule_id`, `user_id`, `group_id`                                                         | read            | principals                     |
| `budgets`                          | `secret_id`, `organization_id`, `limit_cents`, `period`                                  | read            | budget                         |
| `budget_spends`                    | `secret_id`, `organization_id` (rendered subject), `period`, `spent_nanos`, `updated_at` | read + upsert   | budget                         |
| `users`                            | `id`, `external_auth_id` (via free `db::find_user_by_external_auth_id`)                  | read            | cognito                        |
| `secrets`                          | `scope`, `type`, `host_pattern` (via `SecretRow` passed in)                              | read (indirect) | budget, platform_llm           |

Not touched by ee but load-bearing for its inputs: `app_connections` (session policy is
never persisted; SELECTs hard-code NULL), `policy_rules_v2` + identities/targets
(composition input), `api_keys` / org API keys (auth lookups happen in free code).

## 11. E2E tests to rewrite or re-lane if the fork crate is always entitled

Harness default lane is already `EDITION=onprem` + `ENTERPRISE_ENABLED=true` (licensed
self-host). With no flag, the flag-off scenarios lose meaning; the licensed twins stay.

| File                                 | Scenario(s)                                                    | Action                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlicensed.test.ts`                 | "org secrets inject unlicensed…" and its LICENSED twin         | Collapse to one parity scenario (org credentials are free either way).                                                                                                          |
|                                      | "an org-scoped app connection resolves… unlicensed" + twin     | Same collapse.                                                                                                                                                                  |
|                                      | "a group-bound BLOCK rule stops firing (#51)"                  | **Delete** (fork: group rules always fire); keep the twin "the license flag makes the same group rule enforce again" as the positive pin (already covered by `policy.test.ts`). |
|                                      | "a rule naming a group-INHERITED member stops matching"        | **Delete**; keep twin ("restores group-inherited principals") as a positive pin.                                                                                                |
|                                      | "a DIRECTLY granted user still matches unlicensed"             | Keep as a plain licensed scenario (still true).                                                                                                                                 |
|                                      | "a restricted availability posture is ignored (#29)"           | **Delete** or invert to expect `app_unavailable` (duplicate of `control.test.ts`).                                                                                              |
|                                      | "the org approvals feed answers the license 403 (#59)"         | **Invert**: expect 200 `{requests, timeoutSeconds}` (or 403 `organization_scope_required` with a workspace key).                                                                |
|                                      | "an org key of a mere MEMBER authenticates unlicensed"         | **Invert**: expect 401 (recheck always armed). Keep twin.                                                                                                                       |
|                                      | "a seeded resource scope is IGNORED unlicensed"                | **Delete**; keep twin (`resource_access_denied`, `allowed: []`).                                                                                                                |
|                                      | org policy floor parity pair                                   | Collapse to one scenario.                                                                                                                                                       |
|                                      | "a Redis-configured unlicensed gateway refuses to start (#7)"  | **Rewrite** to the fork's chosen posture for `REDIS_HOST` (ignore vs refuse), or delete with HA.                                                                                |
| `platform-llm.test.ts`               | all 6 (cloud lane, `EDITION=cloud` + Cognito/KMS dummies)      | **Delete** with `platform_llm` (the cloud boot fail-fast they exercise also goes).                                                                                              |
| `resource-boundary.test.ts`          | all 7                                                          | Keep unchanged (already licensed lane).                                                                                                                                         |
| `control.test.ts` "app availability" | 2                                                              | Keep if availability is kept; delete with it otherwise.                                                                                                                         |
| `approval.test.ts`                   | org-feed scenario                                              | Keep (drop nothing); ensure the harness spawns without `REDIS_HOST` if HA is removed (`src/gateway.ts` passes `config.redisHost`; `E2E_REDIS_HOST` in `src/env.ts`).            |
| `policy.test.ts` "rule identities"   | 4                                                              | Keep.                                                                                                                                                                           |
| Harness (`src/gateway.ts`)           | default env sets `ENTERPRISE_ENABLED: "true"` and `REDIS_HOST` | Remove the flag; remove Redis wiring if HA dropped; `assertEdition` on the boot line stays.                                                                                     |

Rust-side tests to re-lane: `budget/binding.rs::entitlement_pg_tests` (differential on
`entitled`) → becomes a plain "seeded budget resolves" test; `ha::tests` (entitlement table)
→ delete with HA; `principals::parity_tests` keep (documents the direct arm), or drop the
free twin entirely.

## 12. Fork relevance summary

| Module                                | Verdict                    | Note                                                                                                                   |
| ------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `granular_access` (+ github, dropbox) | KEEP                       | Always stamp session policies; no `entitled` branch.                                                                   |
| `principals::resolve`                 | KEEP                       | `find_principal_set` becomes the only resolver; free twin dead.                                                        |
| `principals::availability`            | KEEP or TRIM               | Keep if the admin UI for App Availability exists in the fork; else return the open default and drop `app_unavailable`. |
| `rbac`                                | KEEP                       | Always install the role resolver.                                                                                      |
| `budget`                              | KEEP + REWRITE eligibility | Spend/meter/pricing unchanged; binding must target org/workspace secrets; drop trial-credit code path.                 |
| `ha`                                  | DROP                       | In-memory stores already meet the contract in §5.                                                                      |
| `org_routes`                          | KEEP                       | Remove the license 403 branch.                                                                                         |
| `response`                            | TRIM                       | Drop `quota_exceeded` and the `trial_credit_exhausted` arm.                                                            |
| `platform_llm`                        | DROP                       | Cloud-only by code.                                                                                                    |
| `cognito`                             | DROP                       | Cloud-only by code.                                                                                                    |
| `kms_crypto`                          | DROP                       | Dead by config on self-host.                                                                                           |
