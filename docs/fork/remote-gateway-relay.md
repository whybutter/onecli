# Remote gateway relay (mTLS + CSR + relay + binding)

The full operator story for running an agent host that is **not** on the same machine as the
gateway. Upstream OneCLI has no such feature — this is new capability, ported from the pre-v2
fork's remote-gateway-hardening effort (PRs #2–#5) onto the v2 crate workspace in Phase 4
([#58](https://github.com/whybutter/onecli/pull/58)). This page replaces the pre-v2 fork's
`docs/remote-gateway-deploy.md`, which does not exist on this tree (confirmed in the Phase 4
[senior review record](../upstream-sync/v2-migration/phase4-plan.md)) — nothing was deleted; it
was never ported, and this page is its intended replacement.

## Why this exists

A gateway normally trusts every agent container reaching it over the plaintext HTTP-proxy port,
because both sides are on the same host/network. A **relay** — a small process co-located with a
remote agent host — needs a way to prove _which tenant_ it is allowed to inject credentials for,
over an untrusted network, without shipping that tenant's long-lived API key onto the remote box.
The stack below solves that with short-lived client certificates and a binding check that ties a
certificate's identity to exactly one workspace.

## The pieces

| Piece               | Crate                  | What it does                                                                                                                                                                                   |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mTLS listener       | `client-ca`            | A second gateway entrypoint, separate from the plaintext port, that requires a client certificate signed by the gateway's own client CA (or an operator-supplied external one).                |
| CSR issuance        | `client-ca` + `server` | The gateway holds a client-certificate minting authority; a relay proves possession of a workspace-scoped `oc_` API key to Node, which forwards the CSR to the gateway's internal issue route. |
| Relay subcommand    | `relay`                | `onecli-gateway relay` — a separate, minimal program (no CA/DB/crypto/vault) that blind-byte-splices a local plain HTTP-proxy port to the remote gateway's mTLS port.                          |
| Binding enforcement | `binding` + `server`   | Ties a verified client-certificate identity to exactly one `workspace_id` (and, redundantly, `organization_id`), denying — or just logging — a mismatch.                                       |

## How a relay connects

1. An agent container on the remote host points its `HTTPS_PROXY` at the relay's local bind
   (`RELAY_BIND`, plain HTTP proxy — no cert needed on this side).
2. The relay enrolls (or renews) its own client certificate: it generates a keypair, builds a CSR,
   and calls `POST /v1/gateway/client-cert` on the Node API (`RELAY_API_URL`, authenticated with
   `RELAY_API_KEY`, a workspace-scoped `oc_` key). Node validates the CSR
   (`packages/api/src/validations/client-cert.ts`, 16 KiB cap, `.strict()` schema — no key
   material accepted in the request body, only a CSR) and forwards it to the gateway's internal
   `POST /v1/internal/client-cert/issue` (`packages/api/src/lib/gateway-client-cert.ts` →
   `apps/gateway/crates/server/src/client_cert_route.rs`), authenticated by the shared
   `GATEWAY_INTERNAL_SECRET` (`X-Gateway-Secret` header, constant-time compared).
3. The gateway mints a short-lived cert bound to a `ClientHost` row keyed by `workspace_id` (and
   optionally `organization_id`), ignoring any identity fields the CSR itself supplied — identity
   comes from the authenticated API key, never from client-controlled CSR content.
4. The relay opens an mTLS connection to the remote gateway's `GATEWAY_MTLS_PORT`
   (`RELAY_GATEWAY_ADDR`), verifying the gateway's _server_ certificate against
   `RELAY_GATEWAY_SERVER_CA` (required — the relay never falls back to an accept-any verifier).
5. From then on the relay is a raw-TCP byte-splice: it does not parse HTTP, so CONNECT tunnels
   (arbitrary TLS to any upstream) pass through unmodified. This is why the relay's local bind must
   be reachable as a **raw TCP proxy**, not behind an HTTP-aware reverse proxy that would try to
   interpret the CONNECT method.
6. Every request the gateway serves on the mTLS listener is checked by binding enforcement: the
   verified cert identity's `ClientHost.workspace_id` must equal the agent token's `workspace_id`.
7. `RELAY_STATE_DIR`, if set, persists the relay's keypair, current cert and host id (mode `0600`)
   across restarts, so it renews its existing identity instead of enrolling as a brand-new host
   every start.

## Env vars

| Var                                               | Where read    | Default                                         | Purpose                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GATEWAY_MTLS_PORT`                               | gateway       | unset → mTLS disabled                           | Port for the mTLS entrypoint. Opt-in: unset is full backward compatibility.                                                                                                                                                                                          |
| `GATEWAY_TLS_CERT`, `GATEWAY_TLS_KEY`             | gateway       | —                                               | The mTLS listener's own server certificate/key (inline PEM or a file path).                                                                                                                                                                                          |
| `GATEWAY_CLIENT_CA`                               | gateway       | unset → gateway mints its own client CA         | An externally managed trust anchor for client certs. When set, `GATEWAY_CLIENT_CA_KEY`/`GATEWAY_CLIENT_CA_CERT` are **ignored** and cert minting is unavailable (`POST /v1/internal/client-cert/issue` 503s) — the gateway never holds an external CA's private key. |
| `GATEWAY_CLIENT_CA_KEY`, `GATEWAY_CLIENT_CA_CERT` | gateway       | unset → generate-and-persist under the data dir | Only used when `GATEWAY_CLIENT_CA` is unset; lets an operator supply the gateway's own minting CA instead of letting it self-generate one.                                                                                                                           |
| `GATEWAY_BINDING_ENFORCEMENT`                     | gateway       | `off`                                           | `off` \| `log` \| `enforce` — see [Rollout](#rollout-off--log--enforce) below. Unset or unrecognized value → `off` (unrecognized also logs a warning; genuinely unset does not).                                                                                     |
| `GATEWAY_PLAIN_BIND`                              | gateway       | unset (binds wide)                              | Restricts the **plaintext** listener to loopback so it can't bypass mTLS/binding enforcement — see [Plain-bind and loopback](#plain-bind-and-loopback-tradeoff).                                                                                                     |
| `GATEWAY_INTERNAL_SECRET`                         | gateway + api | —                                               | Shared secret for the gateway↔Node internal endpoints (`X-Gateway-Secret` header). Same var, two independent `OnceLock`-cached directions — do not assume merging them is safe.                                                                                      |
| `GATEWAY_INTERNAL_URL`                            | api           | derived from `gatewayHttpOrigin()`              | Where Node calls the gateway's internal issue route. Must resolve to an `https://` or loopback address — `mintClientCert` refuses a non-loopback `http://` target so the internal secret is never sent in clear over a reachable network.                            |
| `RELAY_BIND`                                      | relay         | `127.0.0.1:10255`                               | Local plain HTTP-proxy address the relay listens on for agent containers.                                                                                                                                                                                            |
| `RELAY_GATEWAY_ADDR`                              | relay         | — (required)                                    | `host:port` of the remote gateway's mTLS listener.                                                                                                                                                                                                                   |
| `RELAY_GATEWAY_SERVER_NAME`                       | relay         | host part of `RELAY_GATEWAY_ADDR`               | TLS SNI / server-cert verification name.                                                                                                                                                                                                                             |
| `RELAY_GATEWAY_SERVER_CA`                         | relay         | — (required)                                    | Trust anchor for the remote gateway's _server_ certificate (inline PEM or path). The relay always verifies this; there is no accept-any mode.                                                                                                                        |
| `RELAY_API_URL`                                   | relay         | — (required)                                    | Node API base URL used to enroll/renew via `POST /v1/gateway/client-cert`. Must be `https://` or loopback — same fail-closed rule as `GATEWAY_INTERNAL_URL`, so the `oc_` key in `RELAY_API_KEY` is never sent in clear.                                             |
| `RELAY_API_KEY`                                   | relay         | — (required)                                    | Workspace-scoped `oc_` key, sent as `Authorization: Bearer` on enroll/renew.                                                                                                                                                                                         |
| `RELAY_LABEL`                                     | relay         | none                                            | Optional human-readable label on the enrolled `ClientHost` row.                                                                                                                                                                                                      |
| `RELAY_STATE_DIR`                                 | relay         | none → re-enrolls every start                   | Persists the relay's keypair/cert/host id (mode `0600`) across restarts.                                                                                                                                                                                             |

**None of the above are in `.env.example`** — see the gap noted in [`README.md`](README.md).

## Rollout: off → log → enforce

`GATEWAY_BINDING_ENFORCEMENT` (`apps/gateway/crates/binding/src/lib.rs`) has exactly three modes,
designed as a rollout path:

1. **`off`** (default) — `evaluate()` is never even called; zero DB/cache overhead beyond a mode
   check. An unset var is byte-for-byte backward compatible.
2. **`log`** — computes the real decision; a would-be deny becomes `WouldDeny`, which the caller
   logs and allows anyway. Lets an operator watch what `enforce` would do before flipping to it.
3. **`enforce`** — denies for real (403, reason logged, never returned to the client).

The rule itself: a request on the mTLS listener is permitted iff the `ClientHost` row resolved from
the cert identity's spiffe URI has `workspace_id == token.workspace_id`, is not revoked, and — if
it carries an `organization_id` — that also matches the token's. No row for the spiffe URI is a
deny (deny-unless-permitted; the row _is_ the allowlist entry). The plain listener is exempt in
every mode, by listener kind — never inferred from whether an identity was parsed, because an mTLS
handshake with an unparseable CN/SAN must still deny under `enforce`.

## Plain-bind and loopback tradeoff

The plaintext listener has no client-certificate check at all. If mTLS is configured but the
plaintext listener isn't loopback-bound, anyone who can reach that port bypasses certificate
authentication (and binding enforcement, which only runs on the mTLS listener) entirely. The
gateway logs two independent boot warnings for this:

- mTLS configured + plain listener not loopback → set `GATEWAY_PLAIN_BIND=127.0.0.1`.
- `GATEWAY_BINDING_ENFORCEMENT=enforce` + plain listener not loopback → same remedy.

The tradeoff, also logged: binding the plain listener to loopback breaks Docker-published
browser→gateway calls (vault/approval/cache), which arrive on the plaintext listener in a
same-host deployment. This is why `GATEWAY_PLAIN_BIND` is opt-in, not the default.

## Raw-TCP passthrough requirement

The relay's byte-splice (`crates/relay/src/tunnel.rs`) never parses HTTP. Anything in front of the
relay's `RELAY_BIND` — a reverse proxy, a load balancer — must forward it as an opaque TCP stream,
not as HTTP/1.1 with method-aware routing, or CONNECT tunnels (which carry arbitrary TLS traffic to
whatever upstream the agent is calling) will break.

## Testing

| Layer                              | Files                                                                                                                                                                                                                                            | Notes                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure decision core (unit)          | [`crates/binding/src/lib.rs`](../../apps/gateway/crates/binding/src/lib.rs) tests                                                                                                                                                                | Table-driven: off/log/enforce × identity/lookup/revoked/mismatch combinations.                                                                                                                                                                                         |
| CSR route (unit)                   | [`crates/server/src/client_cert_route.rs`](../../apps/gateway/crates/server/src/client_cert_route.rs) tests                                                                                                                                      | 401/413/400/503/200 paths, ~15 cases including "ignores the CSR's own identity fields".                                                                                                                                                                                |
| DB/cache glue (unit, mocked state) | [`crates/server/src/binding_enforce.rs`](../../apps/gateway/crates/server/src/binding_enforce.rs) tests                                                                                                                                          | Cache-then-DB resolution, negative caching, 502 vs 403 on lookup failure.                                                                                                                                                                                              |
| Black-box e2e                      | `apps/gateway-e2e/tests/{mtls,client-cert,relay,binding}.test.ts`                                                                                                                                                                                | Spawn the real binary. `mtls.test.ts` runs on template `onecli_gateway_e2e_template_p2`; `client-cert`/`relay`/`binding` run on `onecli_gateway_e2e_template_p4` (a clone of `_p2`, migrated and frozen — never point these at the main checkout's ports 10254–10256). |
| API-side enrollment                | [`packages/api/src/routes/gateway-client-cert.test.ts`](../../packages/api/src/routes/gateway-client-cert.test.ts), [`packages/api/src/services/client-host-service.pg.test.ts`](../../packages/api/src/services/client-host-service.pg.test.ts) | Revoked-host exclusion from renewal, org-key enrollment path.                                                                                                                                                                                                          |

## What nanoclaw does with this

Today, nanoclaw talks to a gateway on the same host over the plaintext proxy — see
[`nanoclaw.md`](nanoclaw.md). Phase 5b (not yet done — see [`README.md`](README.md#status--roadmap))
is where a remote nanoclaw host runs the `relay` subcommand instead, pointed at a Dokploy-hosted
gateway's mTLS listener, with `GATEWAY_BINDING_ENFORCEMENT=log` first and `enforce` once traffic
looks correct in the logs.

## Known limitations / follow-ups

- **Enroll-route rate limiting is not implemented.** Enrollment already requires a valid
  workspace-scoped credential; a token bucket needs new infrastructure (no Redis) and was
  deliberately deferred ([Phase 4 vetting notes](../upstream-sync/v2-migration/phase4-plan.md)).
- **No `ClientHost.revokedAt` writer exists yet** — the column and the binding-enforcement read
  path are there, but nothing in the product UI/API revokes a host today.
- **`ProxyContext.client_identity`** (threading the verified identity further into request context
  for future features) is deferred.
- **`client_hosts.workspace_id` is `ON DELETE CASCADE`** (an org's `organization_id` FK is
  `ON DELETE SET NULL`): deleting a workspace silently drops its client hosts rather than blocking
  the delete, since nothing can list/manage client hosts yet and a `RESTRICT` would make the
  workspace permanently undeletable.

## History

| PR                                                 | What it added                                                                                                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#58](https://github.com/whybutter/onecli/pull/58) | Phase 4: `client-ca`, `relay`, `binding` crates; second `Entrypoint`; `POST /v1/gateway/client-cert`; `client_hosts` migration; the senior review's two must-fix cleartext-secret bugs (fixed before merge) |
| [#59](https://github.com/whybutter/onecli/pull/59) | Consolidated onto `v2` alongside Phases 3 and 5a                                                                                                                                                            |

Full narrative and the senior review record: [`../upstream-sync/v2-migration/phase4-plan.md`](../upstream-sync/v2-migration/phase4-plan.md).
