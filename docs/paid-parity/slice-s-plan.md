# Slice S — Security + defect fixes: approved implementation plan

**Status:** vetted and approved by the orchestrator. Implement this.

## Orchestrator rulings on escalated questions

| Question                                                                          | Ruling                                                                                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| May this slice edit `overview/_components/api-key-card.tsx`? (D1 helper adoption) | **Yes — approved.** No parallel slice owns it. Adopting the shared helper there is required; two masking implementations would drift.                    |
| May this slice edit `connections/_components/app-icon.tsx`? (D4)                  | **Yes — approved.** It is the only correct fix point and the choke point for 10 call sites.                                                              |
| May this slice edit `lib/policy-editor/policy-editor.tsx`? (D2 `filtered` prop)   | **Yes — approved.** One line, single caller, same directory as the owned table.                                                                          |
| May this slice edit `(dashboard)/_components/try-demo-command.tsx`?               | **Yes — approved.** Slice A's owned list is explicit and does not include it. Prefer the prop over duplicating the block.                                |
| Is there a gap-analysis §5b constraint the planner didn't see?                    | **No.** §5b is the same defect list already in the brief. Nothing extra.                                                                                 |
| Residual query-string exposure                                                    | **Confirmed: file against the cloud service, do NOT close it with the masking fix.** See "Residual exposure" below — this must be stated in the PR body. |

**Revised owned-file list:** the original list plus `overview/_components/api-key-card.tsx`, `connections/_components/app-icon.tsx`, `lib/policy-editor/policy-editor.tsx`, `(dashboard)/_components/try-demo-command.tsx`, `install/_components/tool-pills.tsx`, and the new `lib/mask-secret.ts` + test.

---

## D1 — HIGH/SECURITY: install page leaks the API key

### Root cause

`install-content.tsx` builds two command strings, both containing the raw 64-hex key, and hands either to `TryDemoCommand`, which renders it verbatim in a `<pre>`:

- **Cloud branch** → `curl -fsSL ".../v1/install/cli?key=oc_<64hex>&tool=..." | sh` — key in the **query string**.
- **OSS branch** → `onecli auth login --api-key <key>` — key in **cleartext**. This is the one reproducible on localhost, since no `.env` means the running instance is the OSS edition.

Both must be fixed. `getInstallInfo` returning the full key to the client is correct and unavoidable — the copy button must produce a working command. React Query is not persisted to localStorage, so the key lives only in memory: the same exposure profile as `/overview`, which is already accepted.

### Fix — masked with reveal (owner's decision; do NOT build a single-use token)

**1.1 Extract the mask helper.** New file `apps/web/src/lib/mask-secret.ts` — const arrow `maskSecret(value: string): string` replicating `api-key-card.tsx:48`'s shape (`slice(0,6)` + 12 bullets + `slice(-4)`), plus a short-value guard (`length <= 10` → `"•".repeat(8)`, never a partial reveal of a short string). Add `mask-secret.test.ts` alongside, per repo convention. Then swap `api-key-card.tsx` to import it — one line, kills the drift risk.

**1.2 Both builders emit a masked twin.** In `install-command.ts`: do **not** add a masking mode to `buildCliInstallCommand` — call it twice, once with the real key, once with `maskSecret(apiKey)`. Move the inline `manualCommand` array out of the component into a new exported `buildManualInstallCommand(ctx, { agentIdentifier })` so it can be called the same way and unit-tested. (The file's own header already claims to be the single source for setup commands; the inline array contradicts that.)

Add to `install-command.test.ts`: for both builders, assert the masked-key output contains no `oc_[0-9a-f]{64}` substring, and that real-key output stays byte-identical to today. **Do not change the four existing assertions.**

**1.3 Reveal + copy — the crux.** The component holds two strings:

- `command` — real, working. Never rendered while masked.
- `displayCommand` — built from `maskSecret(apiKey)`. Rendered.

**The copy button calls `copy(command)` — the real string — regardless of reveal state.** This is exactly `api-key-card.tsx`'s contract, so the pasted command works whether or not the user ever clicks the eye. The eye only swaps which string the `<pre>` renders.

**`select-none` on the `<pre>` while masked** — without it a user can drag-select the bullets and paste a broken command that fails with an unhelpful auth error and looks like our bug. Drop `select-none` when revealed.

Implementation: extend `try-demo-command.tsx` with one **optional** prop `secret?: string`. Absent → behaves exactly as today (step 3's run command and the onboarding caller unaffected; `install-content.tsx` is the only caller, lines 129/151). Present → render `command.replaceAll(secret, maskSecret(secret))` unless revealed, plus an `Eye`/`EyeOff` ghost button left of the copy button. `highlight` and `secret` are not used together — document that.

Accessibility: `aria-label={revealed ? "Hide API key" : "Show API key"}` (`api-key-card.tsx` lacks this today — do not copy that gap), plus an `sr-only` line "API key hidden — use the copy button to copy the working command."

**1.4 Wire up.** Guard: when `installInfo?.apiKey` is undefined the manual command falls back to the literal `oc_...` placeholder — pass `secret={undefined}` there. **Never pass an empty string** — `replaceAll("")` loop-inserts.

**1.5 Include the rotation hint.** One muted line under step 2: "This command carries your project API key. Rotate it in Settings → API keys if it is ever shared.", linking to `/settings/api-keys`. Three lines that turn a silent exposure into a recoverable one.

### ⚠️ Residual exposure — must be stated in the PR body, not silently closed

Masking fixes the **screenshot** vector. It does not fix:

- The key still rides in the URL query string on the cloud install command → server access logs, proxy/CDN logs, browser history, and any copy pasted into chat or CI.
- On OSS, `onecli auth login --api-key oc_…` lands in **shell history**.
- The key is **long-lived and project-wide**. `ApiKey` (`schema.prisma:272-293`) has no `expiresAt`, no `lastUsedAt`, and no revoke path other than regenerate — no blast-radius limit if one leaks.

`GET /v1/install/cli` **is not in this repository** — it is served by the closed cloud API, so the transport cannot be changed or tested here. Transport options assessed: **`Authorization: Bearer` header is the right follow-up** (still a one-liner, gets the key out of the URL; needs the endpoint to accept both forms during rollout). Env var is weaker. **stdin is not viable** — in `curl … | sh`, stdin is already the script.

**File two follow-ups:** (a) accept `Authorization: Bearer` on the cloud `/v1/install/cli` and switch the dashboard to it; (b) add `expiresAt` + `lastUsedAt` to `ApiKey` plus a real key lifecycle.

### Verification

Local is OSS, so step 2 shows the manual command. (1) No `oc_[0-9a-f]{64}` visible anywhere on `/install`. (2) Eye toggles both ways. (3) **Copy while masked → paste → the key is the real 64-hex value.** This is the test that matters. (4) Masked `<pre>` can't be drag-selected; revealed one can. (5) Step 3 unchanged. (6) Cloud branch can't run locally (`@/ee/*` doesn't exist) — verify via the new unit assertions.

---

## D4 — app logos render as grey squares

### Root cause — verified against the running server

`next/image` routes local `src` through the optimizer, which **rejects SVG** unless `images.dangerouslyAllowSVG` is set. `next.config.js` has **no `images` key at all**:

```
GET /icons/github.svg                               → 200 image/svg+xml
GET /_next/image?url=%2Ficons%2Fgithub.svg&w=64&q=75 → 400
     "url" parameter is valid but image type is not allowed
```

Deterministic, reproduced on a second icon. All 89 SVGs in `public/icons/` fail. The grey square is `AppRow`'s `bg-muted` wrapper with a broken `<img>` inside. Corroboration: `tool-pills.tsx` already carries an `iconErrors`/`onError` Lucide fallback (someone worked around this locally), and `connection-account-card.tsx:129` already passes `unoptimized`.

**Correction to the QA report:** this cause is _permanent_, not "fills in on a later load." The "~12, fills in later" observation matches a **separate** thing — `apps-tab.tsx` renders `Array.from({ length: 12 })` skeletons while three queries are pending, i.e. exactly twelve grey squares on a cold cache. **Hypothesis, not confirmed** (the planner couldn't sign in).

### Fix

Add `unoptimized` to both `<Image>` elements in `connections/_components/app-icon.tsx` and to the one in `install/_components/tool-pills.tsx`. SVG gains nothing from the optimizer, so this means the browser fetches `/icons/x.svg` straight from `public/` — cacheable, one fewer hop, no "dangerously" flag. `AppIcon` is the choke point for 10 call sites, so one edit fixes all.

**Rejected:** `dangerouslyAllowSVG` in `next.config.js` — adds a server hop for zero benefit, and that file is cross-cutting and unowned.

**Then re-observe the skeleton hypothesis. Do NOT act on it blind.** Land `unoptimized` first, hard-reload `/connections` with a cold cache, and watch. If twelve grey rows still flash, the minimal fix is splitting the gate so the grid renders once `connectionsQuery` resolves — **but that must be paired with holding the Connect button `disabled` until `configuredQuery`/`envDefaultsQuery` settle**, because `handleConnect` reads both to decide whether to open `ConfigureCredentialsDialog`, and empty sets would wrongly show the config dialog for an already-configured app. Treat as optional, only if re-observation justifies it.

**Follow-up sweep (out of scope):** same `unoptimized` needed in `activity/_components/provider-icon.tsx`, `connections/_components/secret-card.tsx`, `secret-dialog.tsx`, `vaults-tab.tsx`, `onepassword-picker-dialog.tsx`, `(connect)/app-connect/_components/connect-layout.tsx`.

### Verification

On `/connections`, devtools: `[...document.querySelectorAll('img')].map(i => ({src: i.currentSrc, nw: i.naturalWidth}))` — every entry `naturalWidth > 0` and `src` of `/icons/*.svg`, **not** `/_next/image?...`. No 400s in the network tab. Check `/install` pills show real logos, not the `Terminal` fallback. **Check both light and dark** — `AppIcon`'s `darkIcon` branch renders two `<Image>`s and both need the flag.

---

## D2 — `/policy` empty state above a populated row

### Root cause

In `policy-rules-table.tsx`'s `<TableBody>`, the empty row is gated on `rules.length === 0` alone; the `defaultRule` row renders right after with no relation between the conditions.

### The subtlety that makes the one-line fix wrong

The same empty row carries **two** messages from `policy-editor.tsx:247-250`:

- unfiltered: `"No rules yet. Add your first rule to get started."` → **a lie** when a Default row is pinned.
- filtered: `` `No rules match “${query}”.` `` → **still true and still needed** when a Default row is pinned. Without it, a search matching nothing looks like the search silently failed.

So `rules.length === 0 && !defaultRule` would fix the lie and introduce a worse bug.

### Fix

Add an optional `filtered?: boolean` prop to `PolicyRulesTable`; condition becomes `rules.length === 0 && (filtered || !defaultRule)`. Pass `filtered={!!q}` from `policy-editor.tsx` (the trimmed query already exists at line 74).

### Verification

Zero org rules → Default row shows, no "No rules yet". Filter to something non-matching → "No rules match …" appears **and** Default row stays. Add a rule → no empty row. Clear filter → Default-row-only.

---

## D6 — profile email reads as empty

**Root cause:** `<Input id="email" value={email} disabled />` — shadcn `Input`'s base includes `disabled:opacity-50`, so a real value renders at half opacity, indistinguishable from the placeholder on the Name field above.

**Fix:** swap `disabled` → `readOnly`. Not styled by any opacity rule, stays non-editable, and gains focusable/selectable/copyable — better for a field whose job is showing which account you're signed in as. Optionally add `className="bg-muted"` for a non-editable affordance. **Do NOT touch `packages/ui/src/components/input.tsx`** (CLAUDE.md).

_Noted, not fixed:_ the helper text "Email is managed by your Google account" may be inaccurate on OSS/local-auth.

---

## D3 — `/activity` page title

**Root cause:** `activity/page.tsx` exports no `metadata`, so it falls through to the root layout's `title.default`. Every sibling exports one and picks up the `"%s - OneCLI"` template.

**Fix:** `export const metadata: Metadata = { title: "Activity" };`. `page.tsx` is already a server component (`ActivityContent` carries `"use client"`), so no restructuring. Match `install/page.tsx`'s import ordering.

---

## D7 — API keys page plural but singular

**Root cause:** not a card defect — a copy mismatch. `ensureApiKey` provisions exactly one key per (user, scope); `regenerateApiKey` rotates it in place. `ApiKey.name` exists but is never set. One key per project per user IS the product; the plural title over-promises.

**Fix — copy only.** Keep the title, rewrite the description to state reality, e.g. _"OneCLI issues one personal API key per project. Copy it for the CLI, or regenerate it if it leaks."_

**Do NOT retitle to singular here** — the sidebar label lives in `nav-config.ts` and the breadcrumb in `dashboard-header.tsx`, both owned by Slice A. Retitling the page while nav still says "API Keys" trades one inconsistency for a more visible one. **Follow-up:** file the singular rename as one coordinated change owned by whoever holds `nav-config.ts`.

**Explicitly out of scope:** create/name/scope/expiry, key lists, per-key revoke.

---

## D5 — `/connections/apps` redirect: CLOSE AS WORKING-AS-INTENDED

**The original defect report was wrong.** `/connections/apps` is **not a sibling tab** — it is the bare parent segment of the app _detail_ routes (`connections/apps/[provider]/page.tsx`). The Apps tab's own URL is `/connections` (the `(tabs)` index), and `getTabRoutes` maps `apps: base` accordingly. There is no separate apps index to render.

A user reaches `/connections/apps` only by truncating a detail URL; the redirect turns that into the page they meant. Removing it yields a 404 for a truncation — strictly worse.

**Action:** no code change. Add a comment in `connections/apps/page.tsx` explaining that `/connections` _is_ the Apps tab and this segment exists solely as the parent of `[provider]`, so the next reader doesn't re-file it. Keep `redirect()` (307), **not** `permanentRedirect()` (308) — 308s cache aggressively and would be painful to unwind.

_Surfaced, out of scope:_ `connections/(tabs)/secrets/page.tsx` exists but is not in `getTabRoutes` — an orphaned route, separate ticket.

---

## Sequencing

1. **D1** (security, largest surface) — do first, land alone.
2. **D4** primary `unoptimized` fix — independent, unblocks re-observation of the skeleton hypothesis.
3. **D2** — approved to touch the call site.
4. **D6, D3** — trivial, batch them.
5. **D7** — copy only.
6. **D5** — comment only.

Run `pnpm fix` before `pnpm check` if Prettier complains.
