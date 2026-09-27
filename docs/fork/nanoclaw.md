# Nanoclaw integration

Nanoclaw is this fork's agent runtime — a Docker-based orchestrator that runs agents and routes
their traffic through the OneCLI gateway. This page covers the current (same-host) integration and
what Phase 5b changes for a remote deployment.

## Current state (same host)

An operator installs `@onecli-sh/sdk` in their nanoclaw/orchestrator process, sets two env vars,
and calls `applyContainerConfig` before launching each agent container:

| Var              | Required | Purpose                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ONECLI_API_KEY` | yes      | User API key from the OneCLI dashboard (`oc_...`)                                                                                                                                                                                                                                                                                                                  |
| `ONECLI_URL`     | no       | OneCLI control-plane URL. The SDK's default (`https://app.onecli.sh`) is upstream's cloud, not this fork; on v2 the value must be an origin that answers `/v1` — the api-server (`http://host:10256` in ports mode) or a proxy-mode single origin. The web app's origin only works under `next dev`, whose `/v1` rewrites are dev-only (`apps/web/next.config.js`) |

`applyContainerConfig` mutates the `docker run`/`docker create` args in place: it adds
`-e HTTPS_PROXY=...` pointed at the gateway, mounts the gateway's CA cert, and sets whatever else
the container needs to have its outbound HTTPS traffic MITM'd by the gateway for credential
injection. See [`../nanoclaw-integration.md`](../nanoclaw-integration.md) for the SDK usage. That
page is pre-v2 material brought over unchanged: the SDK calls it documents still work (the proxy
hop — `HTTPS_PROXY` at the gateway, same MITM CA — is unchanged on v2), but its `ONECLI_URL`
guidance is stale: the `https://app.onecli.sh` default is upstream's cloud, and the self-host
example `http://localhost:10254` (the web app) only answers `/v1` under `next dev`'s dev-only
rewrites. Against the compose stack, `ONECLI_URL` must be the api-server origin (or a proxy-mode
single origin) — the repoint that Phase 5b makes official. Also noted in the v2.6.0 upstream review
(`docs/upstream-sync/reviews/2026-09-14-v2.6.0.md`, "Migration and compatibility facts").

## What Phase 5b changes (not yet done)

Phase 5b is deployment work, tracked in [`plan.md`](../upstream-sync/v2-migration/plan.md) Phase 5
and not yet started (see [`README.md`](README.md#status--roadmap)). Per that plan, it will:

- Move `ONECLI_URL` to the api-server origin (or a path-routed single origin) rather than the web
  app's origin.
- Make nanoclaw's setup install this fork's own four-image compose stack (`web`, `api`, `gateway`,
  `migrations`) instead of upstream's installer.
- Bump nanoclaw's `versions.json` pin to this fork's own published gateway image
  (`ghcr.io/whybutter/onecli-gateway`) — the "prod gate" for the whole remote-gateway-hardening
  effort is publishing a gateway image that carries the `relay` subcommand (see
  [`remote-gateway-relay.md`](remote-gateway-relay.md)).
- Add a **remote mode**, per nanoclaw PR #34, where a nanoclaw host that is _not_ co-located with
  the gateway runs `onecli-gateway relay` instead of talking to a local gateway directly — the
  operator story for this is fully written up in [`remote-gateway-relay.md`](remote-gateway-relay.md).
- Point the health probe at the api-server, not the web app's probe alias.
- Stand up a Dokploy stack for the target deployment (postgres, migrations, api, web, gateway; one
  HTTPS origin routing `/v1`+`/auth` to api, `/gw` to gateway, everything else to web; the
  gateway's CONNECT port exposed raw-TCP only to the relay's mTLS listener).

## Gate for Phase 5b

Per [`plan.md`](../upstream-sync/v2-migration/plan.md): a nanoclaw host in remote mode completes an
agent turn with an injected credential against the staging stack.

## History

| PR                                                 | What it did                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [#53](https://github.com/whybutter/onecli/pull/53) | Phase 0: brought `docs/nanoclaw-integration.md` over from the pre-v2 fork's history unchanged                       |
| —                                                  | Phase 5b (nanoclaw + Dokploy deployment) is planned, not yet started — see [`README.md`](README.md#status--roadmap) |

Related: [`vault-integration.md`](../vault-integration.md) (Bitwarden/1Password credential sources
the gateway injects for agents nanoclaw launches — unrelated to how agents _reach_ the gateway, but
part of the same "agent never sees the secret" story).
