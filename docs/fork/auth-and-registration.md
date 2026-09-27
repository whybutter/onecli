# Auth & instance settings

The fork's registration policy: who may create a new account on a self-hosted instance, the
first-account bootstrap, and the pre-2.0-upgrade adoption window. Shipped in Phase 5a
([#57](https://github.com/whybutter/onecli/pull/57)).

## Purpose

Upstream v2 forces open email/password self-registration — anyone who reaches the signup page can
create an account. That's wrong for a self-hosted instance meant for one team: this fork adds an
instance-level setting, `ONECLI_REGISTRATION`, that closes public signup by default while still
letting the very first operator (or an upgrading pre-2.0 install's claimer) get in.

## How it works

`REGISTRATION_MODE` (`"open" | "invite"`, default `"invite"`, from `ONECLI_REGISTRATION`) is read
independently by both the api and web processes — a deployment that sets it must set it on both
(`docker/docker-compose.yml` already does). The enforcement point is
[`assertRegistrationAllowed`](../../packages/api/src/lib/registration.ts), called from the
better-auth user-creation hook in [`src/lib/better-auth.ts`](../../packages/api/src/lib/better-auth.ts),
which fires for **both** the password path and a social sign-in that would create a new user — so
there is no route around it.

A new account is admitted iff any of:

1. `ONECLI_REGISTRATION=open`.
2. The instance has **no real users yet** (`registrationState().firstAccount`) — a fresh install,
   or a pre-2.0 upgrade still waiting for its claimer (see below).
3. The email being created (case-insensitively) holds a pending, unexpired `Invitation` row.

Every account, however admitted, is provisioned its own organization on first sign-in; joining
someone **else's** organization always requires an invitation regardless of `ONECLI_REGISTRATION`.

### Refusal order

One refusal outranks the registration policy entirely: `assertUpgradeWindowClear` runs **first**,
and its refusal (`SIGNUP_BLOCKED_BY_UPGRADE`) is never masked by `SIGNUP_REQUIRES_INVITATION`. A
pinned unit case proves this ordering.

### The pre-2.0 upgrade window

A deployment upgrading from the no-login era carries a passwordless placeholder user row
(`LEGACY_LOCAL_AUTH_ID`/`LEGACY_LOCAL_EMAIL`, see `legacy-local-identity.ts`). While exactly that
placeholder plus one claimer exist and the claimer hasn't signed in yet, further registrations are
refused (`SIGNUP_BLOCKED_BY_UPGRADE`) — without this, a second registrant slipping in during that
window would orphan the operator's organization, agents and conversations with no way back. The
claimer's first sign-in completes the adoption and disarms the guard permanently. If it fires with
**more than one** real account already present, the log names the manual remedy (delete every
registered user + their bootstrapped orgs to keep the old data, or delete the placeholder row to
abandon it).

### Case-insensitive invitation matching, carefully

The invitation lookup does a Prisma `mode: "insensitive"` query first (compiles to Postgres
`ILIKE`, which treats `_` — a legal email character — as a single-character wildcard), but that is
used only as a **pre-filter**. The actual admit decision is a strict, literal lower-cased equality
check afterward. This exists because a Phase 5a senior review caught the bug live: without the
strict post-check, `_____@corp.example` would match a pending invitation for `alice@corp.example`.

## Design decisions that differ from upstream

| Decision                                                                                                     | Why                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default is `invite`, everywhere, including `pnpm dev`                                                        | No dev-only default. A fresh dev database has no users, so a first local account is unaffected; a _second_ local account needs `ONECLI_REGISTRATION=open` or a real invitation — the product behaving as designed, not a bug ([`phase5-registration-plan.md`](../upstream-sync/v2-migration/phase5-registration-plan.md) vetting note 2). |
| `ONECLI_REGISTRATION` is never named in user-facing copy                                                     | Strangers see the closed-signup screen; only the operator reads `.env.example` (vetting note 1).                                                                                                                                                                                                                                          |
| A Google account whose email doesn't match a pending invitation is refused with `SIGNUP_REQUIRES_INVITATION` | Acceptable per the vetting notes: the invite-accept flow already rejects a wrong-account join, and the gate keys on the email being created, never on a token (vetting note 5).                                                                                                                                                           |
| Cloud edition is out of scope                                                                                | The cloud signup path redirects away before any of this runs, and the cloud edition never builds in this fork anyway (vetting note 4).                                                                                                                                                                                                    |
| Invite mode is vouching, not seat control                                                                    | Every account still owns a personal org and can invite others — accepted as a product fact, not a defect, in the senior review.                                                                                                                                                                                                           |

## Entry points

| Piece                                                           | File                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRATION_MODE` / `ONECLI_REGISTRATION`                     | [`packages/api/src/lib/env.ts`](../../packages/api/src/lib/env.ts)                                                                                                  |
| Enforcement                                                     | [`packages/api/src/lib/registration.ts`](../../packages/api/src/lib/registration.ts) — `assertRegistrationAllowed`, `assertUpgradeWindowClear`, `registrationState` |
| Hook wiring                                                     | [`packages/api/src/lib/better-auth.ts`](../../packages/api/src/lib/better-auth.ts)                                                                                  |
| Login page (offers signup link only when open or first-account) | [`apps/web/src/app/auth/login/page.tsx`](../../apps/web/src/app/auth/login/page.tsx)                                                                                |
| Signup page (closed-state screen, invite-accept prefill)        | [`apps/web/src/app/auth/signup/page.tsx`](../../apps/web/src/app/auth/signup/page.tsx)                                                                              |
| Client-side copy / guard                                        | [`apps/web/src/lib/auth/{login-content-onprem,signup-content-onprem,auth-errors,require-org-admin}.ts`](../../apps/web/src/lib/auth/)                               |

## Env vars

| Var                   | Default  | Read by                                                                                                        |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `ONECLI_REGISTRATION` | `invite` | Both api and web (each evaluates its own copy at startup — must be set on both). Documented in `.env.example`. |

## Testing

- [`packages/api/src/lib/registration.test.ts`](../../packages/api/src/lib/registration.test.ts) — unit cases including the `ILIKE` wildcard mock and the refusal-order case.
- [`packages/api/src/lib/registration.pg.test.ts`](../../packages/api/src/lib/registration.pg.test.ts) — real-Postgres sign-up proof.
- [`apps/web/src/lib/auth/{login-content-onprem,signup-content-onprem}.test.tsx`](../../apps/web/src/lib/auth/), [`require-org-admin.test.ts`](../../apps/web/src/lib/auth/require-org-admin.test.ts).
- Live QA record (web/api on a scratch worktree, database with existing users): stranger signup
  403s with no user row; a wildcard email against a real invitation is refused; the real invited
  email (any case) succeeds; the closed-signup screen shows no form and no Google button; login
  shows no "Create an account" link. Full record in
  [`../upstream-sync/v2-migration/phase5-registration-plan.md`](../upstream-sync/v2-migration/phase5-registration-plan.md#senior-review-and-qa-record-2026-09-15-orchestrator).

## Known limitations / follow-ups

- **Plus-addressing is not normalized** anywhere in the invitation match — a known, accepted gap.
- **The first-account race** (two registrations landing within the same few milliseconds) is
  pre-existing and unfixed; if it ever fires with more than one claimer, recovery is the manual
  remedy documented in `registration.ts`'s doc comment.
- **An admin with no email provider configured** can still retrieve an invite link manually from
  the members UI after `POST /invitations` returns `emailed: false` — confirmed working, not a gap.

## History

| PR                                                 | What it added                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#57](https://github.com/whybutter/onecli/pull/57) | Phase 5a: `ONECLI_REGISTRATION`, `assertRegistrationAllowed`/`assertUpgradeWindowClear`, closed-signup UI, the case-insensitive-matching review fix |
| [#59](https://github.com/whybutter/onecli/pull/59) | Consolidated onto `v2`                                                                                                                              |
