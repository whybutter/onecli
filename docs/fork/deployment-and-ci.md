# Deployment & CI

How this fork builds and ships images, distinct from upstream's single-repo CI and from the pre-v2
fork's single-image model.

## Purpose

Upstream OneCLI (and the pre-v2 fork) publish from `onecli/onecli`/`carbonodev/onecli`. This fork's
CI and publish workflows are guarded on `github.repository == 'whybutter/onecli'`, so they no-op on
forks and mirrored copies — including this repo's own history before the `whybutter` rename. There
is no cloud infrastructure code anywhere in this repo; deployment is entirely by container image.

## The four-image publish matrix

`publish.yml` builds exactly the images `docker/docker-compose.yml` actually runs and that are our
own code: **web, api, gateway, migrations** — each from its own `docker/<service>.Dockerfile`,
multi-arch (amd64/arm64), pushed to `ghcr.io/whybutter/onecli-<service>` tagged `<version>`,
`<major>.<minor>`, and (non-prerelease only) `latest`. The hosted-agent images (`runner`, `agent`,
`channel-adapter`, `ssh-terminator`) stay pointed at upstream's own published images
(`ghcr.io/onecli/onecli-*`) in `docker-compose.yml` — this fork does not build them, because it
doesn't change their code. `scripts/publish-workflow.test.mjs` is a drift guard asserting the
matrix stays exactly this subset.

## Migrations image, not entrypoint migrations

There is **no** `docker/entrypoint.sh` running migrations on container start (that was the pre-v2
fork's model). Instead, a dedicated one-shot `docker/migrations.Dockerfile` image runs
`prisma migrate deploy` and exits; `docker-compose.yml` makes `api` depend on it with
`condition: service_completed_successfully`, so the serving images (`api`, `web`, `gateway`) carry
no migration tooling at all and can't accidentally run a migration twice under a rolling restart.

## Compose profiles: the hosted-agent runner is off by default

`docker-compose.yml` gates the hosted-agent stack behind Compose profiles: `runner` (the sandbox
daemon + ssh-terminator) and `channel-adapter` are both `profiles: [...]`-scoped, so a plain
`docker compose up` never starts them. **Nanoclaw is this fork's agent runtime** — BYO agents are
the primary door in the UI regardless of whether a runner is registered (see [`web.md`](web.md) and
[`nanoclaw.md`](nanoclaw.md)). The runner code stays in the tree (upstream still maintains it) but
isn't part of this fork's publish matrix or default deployment.

## `ONECLI_EXTERNAL_URL`

The one var that answers "where do people open OneCLI" — deliberately not derived from the address
any process binds to, since only the operator knows the externally reachable one. Every other
address (cookie `Secure` flag, OAuth redirect URIs, the CLI's api-host, install snippets, emails,
Slack buttons, and the absolute links the gateway writes into agent-facing responses) derives from
it by one rule: an `http` value means **PORTS mode** (api and gateway on their own ports on the
same host), an `https` value means **PROXY mode** (one origin, a reverse proxy routes `/v1`+`/auth`
to the api and `/gw/*` to the gateway). Unset means `localhost`, and the gateway warns loudly at
startup when links would point at that fallback (see the `main.rs` startup warnings documented in
[`gateway.md`](gateway.md) / [`remote-gateway-relay.md`](remote-gateway-relay.md)). `APP_URL` is the
permanent legacy alias — kept working, but it never derives the api/gateway origins the way the
canonical var does. `ONECLI_BIND_HOST` is a deprecated legacy dashboard-URL source that still works
but logs a "pin it" warning.

## CI

Three workflows in `.github/workflows/`:

| Workflow      | Trigger          | What it does                                                                              |
| ------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `ci.yml`      | PRs to `main`    | Lint, format, types, tests; the Rust gateway job runs only when `apps/gateway/**` changed |
| `release.yml` | pushes to `main` | release-please opens/merges the release PR and tags                                       |
| `publish.yml` | `v*` tags        | Builds and pushes the four-image matrix above                                             |

Both `release.yml` and `publish.yml` are guarded on `github.repository == 'whybutter/onecli'`.
`release.yml` needs the `ONECLI_OSS_RELEASE` secret configured on that repo.

## Design decisions that differ from upstream

| Decision                                                                 | Why                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository guard on `whybutter/onecli`, not the original `onecli/onecli` | Repo identity: `whybutter/onecli`, `ghcr.io/whybutter/onecli-*` images, `install.sh` banners — all rewritten in Phase 0 ([`phase0-plan.md`](../upstream-sync/v2-migration/phase0-plan.md) WP1).        |
| `cla.yml` and `ci-cache-seed.yml` deleted                                | No CLA process on this fork; the e2e suite runs without Redis so the cache-seed job has nothing to seed ([`phase0-plan.md`](../upstream-sync/v2-migration/phase0-plan.md) free-file conflict surface). |
| Redis dropped entirely                                                   | Single gateway instance is the known ceiling for this fork — no HA story, no cache-seed CI job ([`plan.md`](../upstream-sync/v2-migration/plan.md) decision 6).                                        |
| `docker/docker-compose.legacy.yml` kept (decision 0.B left open)         | Not yet resolved whether to remove it — flagged as an open decision in the Phase 0 vetting notes.                                                                                                      |

## Testing

- `scripts/publish-workflow.test.mjs` — asserts the publish matrix is exactly `web, api, gateway, migrations`.
- `scripts/dev.mjs` — the `pnpm dev` launcher; generates every required secret on first run
  (`BETTER_AUTH_SECRET`, `SECRET_ENCRYPTION_KEY`, `GATEWAY_INTERNAL_SECRET`, `RUNNER_TOKEN`,
  `CHANNEL_ADAPTER_TOKEN`) and writes `.env` — see the root `CLAUDE.md`'s Commands section.

## Known limitations / follow-ups

- **Deployment guide.** `docs/remote-gateway-deploy.md` does not exist on this tree — see
  [`remote-gateway-relay.md`](remote-gateway-relay.md), which is this fork's replacement for it.
  The broader Dokploy/nanoclaw deployment guide (Phase 5b) is not yet written — see
  [`README.md`](README.md#status--roadmap).
- **Install/support domain** (`onecli.sh`, `app.onecli.sh`, `*@onecli.sh` strings) is an
  intentionally open decision (`TODO(fork-domain)` markers) — not yet resolved.

## History

| PR                                                 | What it added here                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [#53](https://github.com/whybutter/onecli/pull/53) | Phase 0: repo identity, four-image publish matrix, migrations image, CLA/cache-seed workflows dropped |
