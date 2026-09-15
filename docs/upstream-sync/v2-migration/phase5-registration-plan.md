# Phase 5 "Auth policy" implementation plan: instance registration setting

Branch `phase5/registration`, based on `integration/phase1-2` (upstream v2.6.0 + our Phases 0–2). Two work packages for two parallel Sonnet developers, in separate worktrees. Decision (Marco, 2026-09-14, fixed): a new instance-level setting `ONECLI_REGISTRATION=open|invite`, default `invite`. Existing members send invite links; Google login works for invited emails; the public signup form is off unless the setting says `open`. Signup is allowed when: the setting is `open`; OR the email has a pending, unexpired invitation; OR the instance has no real users yet (bootstrap of the first owner/pre-2.0 adopter). Holds for both the email/password path and the Google/social path.

## 0. What v2 does today

**Registration is unconditionally open.** The one and only refusal wired into sign-up is the pre-2.0 upgrade window, and it exists to protect an upgrading operator's data, not to gate who may register.

- `packages/api/src/lib/registration.ts:9-23` states the policy in its module doc: "Who is allowed to create an account on a self-hosted deployment: anyone." `registrationState()` (`registration.ts:69-93`) answers two things the auth screens key on: `firstAccount` (no users yet, or exactly the unclaimed pre-2.0 placeholder row) and `adoptsExistingInstall`. `assertUpgradeWindowClear()` (`registration.ts:143-187`) throws `signupBlockedByUpgradeError()` (`registration.ts:104-108`, code `SIGNUP_BLOCKED_BY_UPGRADE`) only while a pre-2.0 placeholder is unclaimed AND a claimer is already registered and hasn't completed its first sign-in yet.
- The single enforcement point for BOTH the password and social paths is `packages/api/src/lib/better-auth.ts`'s `databaseHooks.user.create.before` hook (`better-auth.ts:141-176`): it calls `await assertUpgradeWindowClear(options.prisma ?? db)` (`better-auth.ts:152`) before stamping `externalAuthId` on the row about to be inserted. The comment at `better-auth.ts:142-151` and the `emailAndPassword` block's comment at `better-auth.ts:177-184` both assert "Registration is open on self-host" as a load-bearing fact — both need rewriting as part of this slice (see §1). `emailAndPassword.disableSignUp` is never set — the doc explains it has "nothing to do" today; we still won't use it (see below), but the reasoning is no longer that registration is unconditionally open.
- **Org auto-create on first sign-in**: `GET /auth/session` (`packages/api/src/routes/auth-session.ts:127-267`) is the one place that provisions. On every session it upserts the `User` row, then — only if the user has no default workspace yet and `shouldBootstrapOrg` says so (default: `isNewUser`, `auth-session.ts:103`) — calls `ensureUserOrganization()` (`packages/api/src/services/organization-service.ts:287`). This is unrelated to whether the account was allowed to be CREATED; it fires after the fact and is out of scope for this slice (invitation-joiners skip it because `shouldBootstrapOrg`/an edition hook decides that, not because account creation itself was gated).
- **Invitation model** (`packages/db/prisma/schema.prisma:191-209`): `Invitation` is keyed by `organizationId` (NOT `workspace_id` — Phase 0/2 did not change this), unique on `(organizationId, email)`, with `status: pending|accepted|cancelled|expired` and `expiresAt`. `packages/api/src/services/invitation-service.ts` owns creation (`createInvitation`, line 56), redemption (`acceptInvitation`, line 131, case-insensitive email compare at line 171 via `.toLowerCase()` — **no plus-addressing normalization anywhere**), and the read helpers the `/join` page uses: `findPendingInvitationByToken` (line 217), `findAcceptedInvitationOrgForUser` (line 251, for a re-click by the same person), `explainUnavailableInvitation` (line 293, for the "expired/cancelled/accepted/unknown" screen).
- **Redeeming an invitation for a user who has no account yet** (this is the flow our gate must not break): `apps/web/src/lib/team/join-page.tsx` resolves the token server-side (never trusts the query string for org name/slug — deliberately, to stop a crafted `/join?name=…`). If the visitor is signed out and this is self-host (`!IS_CLOUD`), it redirects to `/auth/signup?token=<token>` (`join-page.tsx:97-99`). `apps/web/src/app/auth/signup/page.tsx:33-56` resolves the token server-side via `findPendingInvitationByToken`, and if still pending, renders `SignupContent` with an `invitation: {token, email, organizationName}` prop; if not pending any more it redirects back to `/join?token=…` so the explanation lives in one place. `apps/web/src/lib/auth/signup-content-onprem.tsx` locks the email field (`readOnly={Boolean(invitation)}`, line 202) and, for the Google button, sets `callbackURL: window.location.href` when an invitation is present (line 171) so the token survives the OAuth round-trip (the default callback would drop it). After sign-in, `usePostAuthRedirect({invitationToken})` (`apps/web/src/lib/auth/use-post-auth-redirect.ts:70-104`) calls `POST /v1/invitations/accept` itself — the invited person is never asked to click "Join" twice. `POST /invitations/accept` (`packages/api/src/routes/invitations.ts:196-255`) deliberately runs outside the org-scoped auth middleware (the caller has no org yet) and only requires a session; it re-validates the token against the session's own DB-resolved email.
- **Bootstrap of the very first account**: nothing outside `registrationState().firstAccount` gates it today — a brand-new instance's very first `/auth/signup` visit renders the normal form with `firstAccount: true` framing (`signup-content-onprem.tsx:135-146`), and `login/page.tsx:23-41` redirects every visitor to `/auth/signup` while `firstAccount` is true so there is nothing to log in to yet. No install script or `scripts/dev.mjs` step creates the first account — it is always created through this exact flow, which is why the new gate MUST treat `firstAccount` as an unconditional allow regardless of `ONECLI_REGISTRATION`.
- **A DIFFERENT "registration" already exists in `env.ts` — do not confuse it.** `RUNNER_TOKEN` and `CHANNEL_ADAPTER_TOKEN` (`packages/api/src/lib/env.ts:135-151`) are called "registration anchors" in their own doc comments — that's the hosted-agent runner/channel-adapter plane registering a Runner/ChannelAdapter row, entirely unrelated to user account sign-up. Nobody should touch those.
- **better-auth error surfacing, already proven and directly reusable**: a thrown `APIError` from the creation hook comes back verbatim as JSON on the password path, and as a `?error=<code>` redirect to `onAPIError.errorURL` (`better-auth.ts:340-347`, `${appOrigin()}/auth/login`) on the social path — this is exactly how `SIGNUP_BLOCKED_BY_UPGRADE` already surfaces today, and our new refusal reuses the identical mechanism, so no new plumbing is needed for the social-path redirect. The web side already has a `MESSAGES` map keyed by these string codes, consulted by BOTH `authErrorMessage()` (password path, reads `error.code`) and `redirectErrorMessage()` (social path, reads `?error=`) in `apps/web/src/lib/auth/auth-errors.ts:23-101` — including an already-present, currently-unused entry for `EMAIL_PASSWORD_SIGN_UP_DISABLED` → "This instance is not accepting new accounts." (that's better-auth's own `disableSignUp` code; we are not using `disableSignUp`, so this entry stays dead, and our new code gets its own entry — see §2).
- **No `NEXT_PUBLIC_` / runtime-config plumbing is needed.** `apps/web/src/app/auth/signup/page.tsx` and `apps/web/src/app/auth/login/page.tsx` are server components that already import server-only API-package modules directly — `registrationState` and `SIGNUP_BLOCKED_BY_UPGRADE` from `@onecli/api/lib/registration`, `isEmailConfigured` from `@onecli/api/services/email-service` — because `apps/web` runs as its own Next.js server process with its own full environment (confirmed in `docker/docker-compose.yml:171-200`: the `web` service gets `DATABASE_URL`, `BETTER_AUTH_SECRET`, etc., not just `NEXT_PUBLIC_*`). There is no `middleware.ts` in `apps/web` (checked — none exists), so nothing here runs on the Edge runtime, which would have refused a Prisma-touching import. The new mode constant follows the exact same path: a plain, non-`NEXT_PUBLIC_` env var, read server-side, imported directly into the two page components.
- **A pg test's title already states the old policy, and it will start failing under the new default.** `packages/api/src/lib/registration.pg.test.ts` — real Postgres, real `better-auth.api.signUpEmail` — is literally titled "open registration over real PostgreSQL" and seeds TWO existing accounts before asserting a third, uninvited signup succeeds (`registration.pg.test.ts:76-97`). Under `invite` default this must now fail (refused, no invitation) unless the test stubs `ONECLI_REGISTRATION=open`. This is the concrete regression WP-A must fix as part of this slice, not a follow-up.
- The pre-2.0 upgrade-window pg proof (`packages/api/src/lib/legacy-adoption.pg.test.ts:358-393`, "the upgrade window refuses a second registrant, through the real sign-up") is **not** at risk: `assertUpgradeWindowClear` is checked (and throws) before our new gate would ever run, in the exact DB state that test seeds, so its assertion (`403` + `SIGNUP_BLOCKED_BY_UPGRADE`) is unaffected — the ordering in §1 preserves this.
- No `apps/gateway-e2e` or `apps/hosted-e2e` suite references sign-up at all (`grep -rln "signUp\|sign-up" apps/gateway-e2e apps/hosted-e2e` is empty) — nothing there needs updating.

## 1. Work packages

Two work packages, two worktrees, developed in parallel against the **interface contract** in §1.2 below (agree on it before either lands; neither needs to wait for the other to merge).

### 1.1 Shared interface contract (read by both WPs before starting)

- `REGISTRATION_MODE: "open" | "invite"` — a frozen, module-load constant (same pattern as every other `env.ts` export, e.g. `EDITION_INFO`), exported from `packages/api/src/lib/env.ts` and re-exported from `packages/api/src/lib/registration.ts` (`export { REGISTRATION_MODE, type RegistrationMode } from "./env";`). WP-B's server components import it from `@onecli/api/lib/registration` — the same module they already import `registrationState` from — never from `lib/env` directly.
- `SIGNUP_REQUIRES_INVITATION = "SIGNUP_REQUIRES_INVITATION"` — an exact string literal, following the EXISTING precedent of `SIGNUP_BLOCKED_BY_UPGRADE`: WP-A defines and exports it from `packages/api/src/lib/registration.ts`; WP-B independently defines the identical literal in `apps/web/src/lib/auth/auth-errors.ts` (that file is imported by client components and deliberately does NOT import the server-only `@onecli/api` module for this — it already duplicates `SIGNUP_BLOCKED_BY_UPGRADE` the same way, at `auth-errors.ts:14`). Both sides must use exactly this string; get it right the first time since it round-trips as an untyped string across the API boundary.
- Neither WP touches the other's owned files. `docker/docker-compose.yml` and `.env.example` are owned by WP-A alone (they're infra/docs, not web source).

### 1.2 WP-A — api-server enforcement, env, tests, docs (owns the policy)

**Owned files:**
- `packages/api/src/lib/env.ts` — add `REGISTRATION_MODE`.
- `packages/api/src/lib/registration.ts` — add the invite gate.
- `packages/api/src/lib/better-auth.ts` — wire it into the creation hook; fix the now-inaccurate comments.
- `packages/api/src/lib/registration.test.ts`, `packages/api/src/lib/registration.pg.test.ts` — new/updated tests.
- `packages/api/src/testing/hermetic-env.ts` — add `ONECLI_REGISTRATION` to `AMBIENT_HAZARD_VARS`.
- `.env.example` — document the var.
- `docker/docker-compose.yml` — thread it through to both the `api` and `web` service `environment:` blocks.
- `/Users/marco/Projects/ai-agents/onecli/.claude/worktrees/v2-phase5-reg/CLAUDE.md` line 133 (the sentence named in the brief).

**Exact edits:**

1. `env.ts`, inserted in the "Auth & Encryption" section right after `GOOGLE_CLIENT_SECRET` (currently line 74):
   ```ts
   export type RegistrationMode = "open" | "invite";

   /**
    * Who may create a NEW account on this instance. "open": anyone (the old,
    * only behaviour). "invite" (default): only an existing member's invite
    * link, or the deployment's very first account (see `registrationState()`
    * in `./registration` — covers both a fresh install and a pre-2.0 upgrade
    * claimer). Case-insensitive; any value other than exactly "open" is
    * "invite" — unset or a typo fails closed, not open.
    *
    * NOT the runner/channel-adapter "registration anchor" tokens below
    * (RUNNER_TOKEN, CHANNEL_ADAPTER_TOKEN) — same word, unrelated concept:
    * those gate a Runner/ChannelAdapter row, not a user account.
    */
   export const REGISTRATION_MODE: RegistrationMode =
     (process.env.ONECLI_REGISTRATION ?? "").trim().toLowerCase() === "open"
       ? "open"
       : "invite";
   ```
2. `registration.ts`:
   - Rewrite the module doc (lines 9–23): it currently asserts "Registration is open by design... a deployment that must not accept strangers keeps its dashboard behind the network boundary — the product deliberately offers no registration switch." That is now false; replace with a statement of the `open`/`invite` policy and point at `REGISTRATION_MODE`.
   - Add `export { REGISTRATION_MODE, type RegistrationMode } from "./env";` near the top (after the existing imports).
   - Add the token + error constructor, mirroring `SIGNUP_BLOCKED_BY_UPGRADE` / `signupBlockedByUpgradeError` exactly (same `APIError("FORBIDDEN", ...)` shape, same code-as-message trick documented at lines 25–33):
     ```ts
     export const SIGNUP_REQUIRES_INVITATION = "SIGNUP_REQUIRES_INVITATION";

     export const signupRequiresInvitationError = (): APIError =>
       new APIError("FORBIDDEN", {
         code: SIGNUP_REQUIRES_INVITATION,
         message: SIGNUP_REQUIRES_INVITATION,
       });
     ```
   - Add the gate function:
     ```ts
     /**
      * Refuse a NEW account unless this instance's registration policy admits
      * it: the setting is "open"; OR `email` (case-insensitively) holds a
      * pending, unexpired invitation to some organization; OR the instance
      * has no real users yet (`registrationState().firstAccount` — a fresh
      * install, or a pre-2.0 upgrade awaiting its claimer).
      *
      * Called from the identity layer's user-creation hook, after
      * `assertUpgradeWindowClear` — that check must win first: it protects
      * data an upgrading operator already has, and its refusal must never be
      * masked by this one.
      */
     export const assertRegistrationAllowed = async (
       email: string,
       prisma: typeof db = db,
     ): Promise<void> => {
       if (REGISTRATION_MODE === "open") return;

       const state = await registrationState(prisma);
       if (state.firstAccount) return;

       const invited = await prisma.invitation.findFirst({
         where: {
           email: { equals: email, mode: "insensitive" },
           status: "pending",
           expiresAt: { gt: new Date() },
         },
         select: { id: true },
       });
       if (invited) return;

       throw signupRequiresInvitationError();
     };
     ```
3. `better-auth.ts:141-176` — call the new gate right after `assertUpgradeWindowClear` (line 152), same `before` hook, same ordering guarantee (password + social, single choke point):
   ```ts
   await assertUpgradeWindowClear(options.prisma ?? db);
   await assertRegistrationAllowed(user.email, options.prisma ?? db);
   ```
   Add the import (`assertRegistrationAllowed` alongside the existing `assertUpgradeWindowClear` import at line 26). Rewrite the comment at `better-auth.ts:142-151` (drop "Registration is open on self-host; the ONE refusal left is...") and the `emailAndPassword` block's comment at `better-auth.ts:177-184` (drop "Registration is open on self-host, so there is nothing for `disableSignUp` to do") to describe both refusals and why `disableSignUp` still isn't used (it's a static, request-blind switch; our gate needs the request's email and the DB state, which only the creation hook has). Leave `requireEmailVerification`/`autoSignIn` untouched — that reasoning (line 185-192) doesn't depend on the registration policy.
4. `hermetic-env.ts` — add `"ONECLI_REGISTRATION"` to `AMBIENT_HAZARD_VARS` next to `MAX_ORGS_PER_USER` (same section, same reasoning: it's a module-load-frozen mode flag, and a leaked shell value would silently flip every test's registration behavior).
5. `.env.example` — new commented block near the Google sign-in section:
   ```
   # Who may create a new account. "open": anyone. "invite" (default): only
   # an existing member's invite link, or this instance's very first account.
   # ONECLI_REGISTRATION=open
   ```
6. `docker/docker-compose.yml` — add `ONECLI_REGISTRATION: ${ONECLI_REGISTRATION:-}` to both the `api:` block (next to `MAX_ORGS_PER_USER` at line 83) and the `web:` block (next to `MAX_ORGS_PER_USER` at line 186) — both processes evaluate this constant independently in their own env.
7. `CLAUDE.md` line 133 — replace "Registration is open by design — every account gets its own organization on first sign-in; joining someone else's org goes through an invitation" with a sentence describing the `ONECLI_REGISTRATION` setting (open/invite, default invite) and that joining is still via invitation either way.

**Tests:**
- `registration.test.ts` (unit, mocked `prisma`, same style as the existing `registrationState` suite): extend the mock to include `invitation.findFirst`; cases for `assertRegistrationAllowed`: open mode always allows (even 2 established users, no invitation); invite mode + firstAccount allows regardless of invitation; invite mode + established + pending unexpired invitation (exact case, and a differently-cased email) allows; invite mode + established + expired invitation refuses; invite mode + established + no invitation refuses (assert the thrown error's `code`).
- `registration.pg.test.ts` — reframe as "registration mode wiring over real PostgreSQL": keep the existing seeded-established-instance fixture but split into (a) `ONECLI_REGISTRATION` unset/default → `signUpEmail` for an uninvited newcomer on the established instance returns the refusal status with `code: SIGNUP_REQUIRES_INVITATION`, and nothing is created; (b) `vi.stubEnv("ONECLI_REGISTRATION", "open")` + `vi.resetModules()` + re-import (same pattern already used in `better-auth.test.ts`'s cloud-edition case) → the existing "accepts a sign-up on an instance that already has accounts" assertion, unchanged; (c) a real pending invitation row for the newcomer's email → default (invite) mode still accepts the sign-up. Do not touch `legacy-adoption.pg.test.ts` — its assertion is already correct under the new default (see §0).

**Verification:** `pnpm --filter @onecli/api test -- registration`; pg suites need `POLICY_PROOF_DATABASE_URL` per `phase2-plan.md`'s convention; `pnpm --filter @onecli/api check-types`; `pnpm --filter @onecli/api lint`.

### 1.3 WP-B — web signup/login pages, invitation-accept prefill, tests

**Owned files:**
- `apps/web/src/app/auth/signup/page.tsx`
- `apps/web/src/app/auth/login/page.tsx`
- `apps/web/src/lib/auth/signup-content-onprem.tsx`
- `apps/web/src/lib/auth/login-content-onprem.tsx`
- `apps/web/src/lib/auth/auth-errors.ts`
- `apps/web/src/lib/auth/signup-content-onprem.test.tsx`
- `apps/web/src/lib/auth/login-content-onprem.test.tsx`
- `apps/web/src/lib/auth/auth-errors.test.ts`

**Exact edits:**

1. `signup/page.tsx` — after resolving `state = await registrationState()` (unchanged for the token branch — an invitation link must always work, at any `REGISTRATION_MODE`), add: if `REGISTRATION_MODE === "invite"` and `!state.firstAccount`, render `SignupContent` in a new `closed` mode instead of the normal form (no token was given, so this visitor is not an invited joiner and this is not the first account).
2. `signup-content-onprem.tsx` — add an optional `closed?: boolean` prop. When true, render the existing `AuthScreen` shell with title `"Invite only"`, body copy `"This OneCLI instance only accepts new accounts by invitation. Ask an existing member to send you an invite link."`, and a single `"Already have an account? Log in"` link to `/auth/login` — no form, no Google button, no email/password fields. (Do not reuse the `firstAccount`/`invitation` framing branches for this — it's a fourth, distinct state.)
3. `login/page.tsx` — compute `signupOpen = IS_CLOUD ? true : REGISTRATION_MODE === "open"` (cloud's own Cognito signup is unaffected either way) and pass it to `LoginContent`.
4. `login-content-onprem.tsx` — add `signupOpen: boolean` to `OnpremLoginContentProps`; wrap the existing "New here? Create an account" block (lines 146-151) in `{signupOpen && (...)}`. (The `awaitingFirstAccount` redirect in `login/page.tsx:38-41` already sends everyone to `/auth/signup` unconditionally while `firstAccount` is true, regardless of this flag — bootstrap is never blocked.)
5. `auth-errors.ts` — add, following the exact precedent of `SIGNUP_BLOCKED_BY_UPGRADE` at line 14 and its `MESSAGES` entry at lines 24-27:
   ```ts
   export const SIGNUP_REQUIRES_INVITATION = "SIGNUP_REQUIRES_INVITATION";
   ```
   and in `MESSAGES`:
   ```ts
   [
     SIGNUP_REQUIRES_INVITATION,
     "This instance only accepts new accounts by invitation. Ask an existing member for an invite link.",
   ],
   ```
   This single map entry is consulted by both `authErrorMessage()` (password-path JSON error) and `redirectErrorMessage()` (social-path `?error=` redirect landing on `/auth/login`) — no other wiring needed on the web side for the Google-refusal case (see §0's "already proven" note).

**No changes needed to:** `apps/web/src/lib/team/join-page.tsx`, `join-form.tsx`, `join-sign-in.tsx`, `join-wrong-account.tsx`, `join-unavailable.tsx`, `use-post-auth-redirect.ts`, or `apps/web/src/lib/cli-auth/**` — the invitation-accept flow never creates an account by itself (it requires an existing session, `invitations.ts:196-202`), and the CLI-pairing page confirms an already-authenticated session's org/workspace choice (`cli-auth-confirm.tsx`) — it never signs anyone up. Both are outside the gate by construction; do not touch them.

**Tests:**
- `signup-content-onprem.test.tsx` — new cases: `closed` renders the invite-only message and no form/Google button; `closed` is ignored when `invitation` is also passed (an invited joiner always sees the join form, never the closed state — assert this precedence explicitly since both could theoretically be true if `page.tsx` had a bug); existing `firstAccount`/`invitation` cases unaffected.
- `login-content-onprem.test.tsx` — new cases: `signupOpen={false}` hides the "Create an account" link; `signupOpen={true}` shows it (existing default assumption made explicit); a `?error=SIGNUP_REQUIRES_INVITATION` query renders the new copy via `AuthFormError`.
- `auth-errors.test.ts` — `authErrorMessage({code: "SIGNUP_REQUIRES_INVITATION"})` and `redirectErrorMessage("SIGNUP_REQUIRES_INVITATION")` both resolve to the exact copy above.

**Verification:** `pnpm --filter web test -- signup-content-onprem login-content-onprem auth-errors`; `pnpm --filter web check-types`; `pnpm --filter web lint`.

## 2. Behaviour spec — decision table

| Mode | Path | Invitation for the email | Users in DB | Result | Message / where it renders |
|---|---|---|---|---|---|
| `open` | password or Google | any | any | **Allow** | — |
| `invite` | password or Google | pending, unexpired (case-insensitive email match) | any | **Allow** | — |
| `invite` | password or Google | none / expired / wrong case-normalized email | 0 users, or exactly the unclaimed pre-2.0 placeholder (`firstAccount: true`) | **Allow** (bootstrap) | — |
| `invite` | password | none / expired | ≥1 established user, no first-account exception | **Refuse** | JSON `{code: "SIGNUP_REQUIRES_INVITATION"}` from `POST /sign-up/email` → rendered under the (in-UI, never-shown-because-gated) signup form via `AuthFormError`/`authErrorMessage`; the normal path is the signup PAGE itself rendering the closed state, so this is the direct-API-call defense-in-depth case |
| `invite` | Google | none / expired | ≥1 established user | **Refuse** | better-auth redirects to `/auth/login?error=SIGNUP_REQUIRES_INVITATION`; login screen shows "This instance only accepts new accounts by invitation. Ask an existing member for an invite link." via `AuthFormError`/`redirectErrorMessage` |
| any | password or Google | — | pre-2.0 upgrade window open (unclaimed placeholder + 1 unfinished claimer) | **Refuse** (pre-existing, unchanged, checked first) | `SIGNUP_BLOCKED_BY_UPGRADE` copy, same rendering paths |
| any | — (accepting an invitation, `POST /invitations/accept`) | — | — | **N/A — gate does not apply.** Requires an existing session; never creates a user row. | — |
| any | — (CLI pairing, `/auth/cli`) | — | — | **N/A — gate does not apply.** Requires an existing session; never creates a user row. | — |

## 3. Risks

1. **Order matters and is easy to get backwards.** `assertUpgradeWindowClear` must run before `assertRegistrationAllowed` in the creation hook. If reversed, an uninvited stranger hitting an established instance mid-upgrade-adoption would see `SIGNUP_REQUIRES_INVITATION` instead of `SIGNUP_BLOCKED_BY_UPGRADE` — cosmetically wrong, and it would also mean the upgrade-window pg proof (`legacy-adoption.pg.test.ts:358-393`) could start asserting the wrong code if invite-mode's own refusal fires first for unrelated reasons. Keep the two calls in the stated order and don't collapse them into one function.
2. **The runner/channel-adapter "registration anchor" name collision.** `RUNNER_TOKEN` / `CHANNEL_ADAPTER_TOKEN` in `env.ts` already use the word "registration" for a completely different concept (a Runner/ChannelAdapter row claiming its identity). Do not name anything here `REGISTRATION_TOKEN` or similar, and don't let a grep for "registration" during review conflate the two.
3. **Race: two concurrent first sign-ups on a brand-new instance.** `registrationState()`'s `firstAccount` read-then-act is not transactional against the insert (same pre-existing shape as the upgrade-window check, which has the identical race and already documents it as acceptable — `registration.ts:130-141`). Two people racing a fresh install's first signup could both read `firstAccount: true` and both get created; this is no worse than today's behavior and is out of scope to fix here, but call it out in review rather than treating it as a new bug this slice introduced.
4. **Invitation email matching is case-insensitive only, not plus-addressing-aware.** `acceptInvitation` normalizes with `.toLowerCase()`; our gate's `mode: "insensitive"` Prisma query matches that exactly. Neither this slice nor the existing invite-accept flow strips `+tag` addressing (`alice+work@x.com` vs `alice@x.com`) — an admin who invites `alice@x.com` and a user who signs up as `alice+cli@x.com` will be refused. This is consistent with existing behavior (the accept route has the same gap) and is not a regression; flag it as a known limitation rather than silently fixing scope into this slice.
5. **A refusal must not read as a redirect loop.** The plan avoids one by construction: `signup/page.tsx` decides server-side and renders a static "Invite only" state (no form to submit, so no error to bounce back from); the Google-refusal path lands once on `/auth/login` with a message, not back on `/auth/signup`. If a future edit makes the closed-signup screen redirect anywhere instead of rendering in place, re-check this.
6. **`better-auth`'s per-request hook has no visibility into which invitation token (if any) was in the URL** — it only sees the email being created. This is fine per the fixed decision (any pending invitation for that email is sufficient, regardless of which org's link was clicked), but don't be tempted to thread the token through for a "tighter" check — it would require plumbing request context into `databaseHooks.user.create.before` that doesn't exist today and isn't needed.
7. **`hermetic-env.ts` omission would be a silent test-suite hazard.** If `ONECLI_REGISTRATION` is left out of `AMBIENT_HAZARD_VARS`, a developer's exported shell var (or a leftover from a prior local `.env`) would silently flip every registration-adjacent test between suites, exactly the failure mode that file exists to prevent (see its own module doc). WP-A must not skip this file.

## 4. Verification commands

```bash
# WP-A
pnpm --filter @onecli/api test -- registration
POLICY_PROOF_DATABASE_URL=<scratch-db-url> pnpm --filter @onecli/api test -- registration.pg
pnpm --filter @onecli/api check-types
pnpm --filter @onecli/api lint

# WP-B
pnpm --filter web test -- signup-content-onprem login-content-onprem auth-errors
pnpm --filter web check-types
pnpm --filter web lint

# Assembled (after both merge into phase5/registration)
pnpm check
pnpm test
```

## 5. Open questions for the orchestrator

1. **Exact copy sign-off.** §2's two message strings ("Invite only" / "This instance only accepts new accounts by invitation. Ask an existing member for an invite link.") are my proposal, not yet reviewed against the product's existing voice elsewhere (e.g. should it name `ONECLI_REGISTRATION` for a self-hosting admin reading their own logs, the way `INVALID_ORIGIN`'s message does at `auth-errors.ts:49-52`?). Please confirm or amend before WP-B implements.
2. **Does `pnpm dev` / local single-developer flow need anything?** Today a fresh `pnpm dev` database has zero users, so the bootstrap exception makes the very first account work unchanged. A SECOND local developer (or a second manual test account) on the same dev DB would now need either a real invitation row or `ONECLI_REGISTRATION=open` in their `.env` — I did not find any dev-setup doc promising "just sign up a second time," so I believe this needs no code change, only for `.env.example`'s comment to be clear enough that a developer hits it once and understands why (drafted in §1.2 step 5). Confirm this is acceptable rather than wanting a dev-only default of `open`.
3. **Merge order into `phase5/registration`.** WP-A and WP-B touch disjoint files and share only the two string/constant contracts in §1.1, agreed up front — either can land first. Confirm no preferred order, or state one.
4. **Should the closed-signup screen also apply to the (dead-in-this-fork) cloud edition?** `signup/page.tsx` already redirects to `/auth/login` unconditionally when `IS_CLOUD` (Cognito owns its own signup), so `REGISTRATION_MODE` never applies there — I've treated this as correctly out of scope per CLAUDE.md ("the EE/cloud edition never builds here"), but flagging since the decision text didn't explicitly say so.
