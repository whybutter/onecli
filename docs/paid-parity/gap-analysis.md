# Paid Parity — Gap Analysis

> ## ⚠️ Product decisions that override this document
>
> 1. **No plan tiers.** Every organization gets the same access. All plan-gating UI in the competitor is therefore out of scope: the breadcrumb plan badge, the sidebar agent-quota meter with its "Upgrade for more agents" CTA, the Members upgrade banner, the "Upgrade to Team" card on Project Settings, lock icons on gated buttons, and the `Upgrade →` CTAs on Usage.
> 2. **Billing and App Availability are dropped entirely.** Both exist in the competitor solely to sell upgrades — App Availability is nothing but an Enterprise upsell card with no feature behind it. With no tiers, neither has a reason to exist.
> 3. **Usage is kept**, but without quota limits or upgrade CTAs — request counts, integration calls, and per-agent usage remain useful on their own.
> 4. **The install-page API key fix is masked-with-reveal**, not a single-use token. See slice S.
> 5. **This repo is an independent fork. The EE/cloud edition never builds, runs, or is updated here.** The `@/ee/*` aliases in `next.config.js` are dead code and `apps/web/src/ee/` will never exist. Do not design around EE compatibility, do not duplicate code to protect a cloud build, and do not file "mirror this in the private repo" follow-ups. The OSS edition is the only one that matters; `IS_CLOUD` branches are dead paths.
>
> The revised org shell is: Projects, Global Connections, Global Policy, [break], Members, Groups, Usage, Organization Settings.
>
> Sections below that describe plan tiers, Billing, or App Availability are retained as a record of what the competitor does, not as work to be done.

Compares the competitor's paid product (see `org-scope-spec.md`, `project-scope-spec.md`) against our current app at `apps/web`.

**Headline:** our **project-scope** screens are already at or beyond parity. Nearly the entire gap is (1) the **navigation shell model** and (2) **org-scope pages we don't have at all**. This is not a "rebuild the UI" effort — it's one structural refactor plus a set of new org-scope pages.

---

## 1. The one structural difference that matters

|                   | Paid                                                                                                                                                                   | Ours                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell model       | **Two distinct shells.** Org shell (9 nav items) and project shell (6 nav items). Entering a project _replaces_ the sidebar and prepends a `‹ All projects` back link. | **One flat shell.** 10 nav items in a single group, mixing org-scope (Team, Groups, Projects) and project-scope (Overview, Install, Agents) items. |
| Project switching | No sidebar switcher. Go back to `All projects`, pick a card.                                                                                                           | `ProjectSwitcher` dropdown in the sidebar.                                                                                                         |
| Org switching     | Chevron beside the logo.                                                                                                                                               | `OrgSwitcher` dropdown in the sidebar.                                                                                                             |
| Breadcrumb        | `Org [Pro] › All projects › Project › Page` (4–5 crumbs)                                                                                                               | Derived from `navItems` + path segments (2–3 crumbs, no org crumb, no plan badge)                                                                  |

Everything else in the backlog is downstream of this. **This must land first and alone** — it touches `src/lib/nav-config.ts`, `dashboard-sidebar.tsx`, `nav-main.tsx`, `dashboard-header.tsx`, and `(dashboard)/layout.tsx`, which every other slice would otherwise collide with.

**Open question for Marco:** their model drops the project switcher entirely. Ours is arguably better UX (one click vs three). Recommend we keep our switcher _and_ adopt the two-shell split — they aren't mutually exclusive.

---

## 2. Org scope — the real gap

| Paid nav item         | Our status                                                                                                                                                          | Work               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Projects              | ✅ `/projects` exists — but renders a **table**, theirs is a **card grid** (folder icon, `3 agents · 14 resources`, `Owned by …`, `⋮`)                              | Restyle            |
| Global Connections    | ❌ **Missing entirely.** Our `/connections` is project-scoped only. Theirs has org-level Apps/Custom/LLMs shared across all projects.                               | New — largest item |
| Global Policy         | ✅ `/policy` already org-scope (`PolicyEditor scope="organization"`). Ours is **more capable** (drag-reorder, staged publish, overlap warnings, condition builder). | Minor polish       |
| Members               | ✅ `/team` — same content, different label. Theirs: card table w/ `YOU` + `INVITED` badges, `3 members` footer, split `Invite ▾` button.                            | Rename + restyle   |
| Groups                | ✅ `/groups` incl. role mappings — close parity                                                                                                                     | Polish only        |
| App Availability      | ❌ Missing. Theirs is a **pure Enterprise upsell card** — no real feature behind it.                                                                                | New, trivial       |
| Usage                 | ❌ Missing. Plan strip, 6-cell quota grid w/ ring gauges, 2 stat cards, usage-by-agent bar table.                                                                   | New, substantial   |
| Billing               | ❌ Missing. Monthly/Yearly toggle, 4 plan cards, Enterprise strip.                                                                                                  | New, substantial   |
| Organization Settings | ⚠️ Partial — see below                                                                                                                                              |                    |

### Organization Settings sub-nav

| Paid                                                       | Ours                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| General (name + read-only Org ID + Copy)                   | ⚠️ `/settings/organization` has name only — **no Org ID field**                                                                                   |
| Domains (add domain, DNS TXT verify)                       | ❌ Missing                                                                                                                                        |
| Single sign-on (SAML/OIDC cards, Require SSO toggle, SCIM) | ❌ Missing                                                                                                                                        |
| API Keys                                                   | ✅ `/settings/api-keys`                                                                                                                           |
| Encryption                                                 | ✅ `/settings/encryption` — **stub on both sides.** Theirs is also a single select + disabled Save. We are already at parity; do not invest here. |

Our settings nav is grouped General / Account / Security and includes `Instance` and `Profile`, which theirs lacks. **Recommend keeping ours** — theirs flattens everything under "Organization" and loses the account/instance distinction.

---

## 3. Project scope — already at parity

| Paid nav item    | Our status                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview         | ✅ Near-exact match — API key card (masked, reveal/copy/regenerate), 4 stat cards, Recent Activity w/ `View all →`                                |
| Install          | ✅ Near-exact match — 3-step stepper, tool pills, agent select, setup status card                                                                 |
| Agents           | ✅ Near-exact match — card list, `Default` badge, identifier chip, credential avatar stack w/ `+N`, Manage, `⋯`                                   |
| Connections      | ✅ **We have more** — ours adds `Budgets` and `Connected` tabs alongside Apps/Custom/LLMs/External Vaults                                         |
| Activity         | ✅ Near-exact match — identical 8 columns, same `All / Hide AI / Blocked` filter, Live toggle. Ours adds inline approve/deny in the Decision cell |
| Project Settings | ✅ **We have more** — theirs gates Project Access behind a Team-plan upsell; ours ships a real access-binding UI                                  |

### Where we are _ahead_ (do not regress)

- **Spend budgets** tab — no paid equivalent
- **Approvals** — bell, pending queue, inline approve/deny in Activity
- **Agent detail** — tri-state permission editor, effective-credential reflection
- **Policy editor** — drag-reorder, staged publish/diff, overlap detection
- **Project access** — real user/group bindings vs their upsell card

---

## 4. Deliberately DO NOT copy

| Their behavior                                                                           | Why not                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unmasked API key in the Install command + install URL query param**                    | Credential leak. Key lands in logs, history, and screenshots — it leaked in the screenshot set we were given. Mask by default; prefer a short-lived one-time install token. |
| Breadcrumb leaf reads `Dashboard` on Global Policy, Global Connections, App Availability | Their bug                                                                                                                                                                   |
| Settings breadcrumbs render `Sso` and `Org api keys`                                     | Raw slug auto-title-casing, their bug                                                                                                                                       |
| Connections sub-tab crumbs render `Llms` / `Vaults`                                      | Same bug                                                                                                                                                                    |
| Sidebar renders only "Projects" in two captures                                          | Nav hydration/permission bug                                                                                                                                                |
| Dropping the project switcher                                                            | Ours is better UX                                                                                                                                                           |

---

## 5. Design-system deltas

Their tokens vs ours (`packages/ui`, 27 shadcn components):

- **Primary = solid black**, green reserved for brand/status only (`Get Started`, active nav, `Connected`, `Pro`). Ours uses `text-brand`/`bg-brand/10` for active nav — already aligned. Verify our primary button is neutral, not brand-colored.
- **Table headers:** uppercase, ~11px, letter-spaced, gray. Ours are default shadcn.
- **Empty states:** rigid copy formula — title `No <things> yet`, body `<Verb> a <thing> to <outcome>.` Ours matches this closely but the markup is **inlined ~10 times** and should be extracted to a shared component.
- **Two empty-state variants:** solid card (larger, circular icon badge) vs dashed border (shorter). Ours only has the solid-card variant.
- **Plan gating:** lock icon on gated buttons rather than hiding them. We have `PlanGateProvider` — wire it to this pattern.
- **Missing primitives** worth adding: no shared `EmptyState`, no table wrapper (two hand-rolled idioms), no `form` (all forms hand-rolled `useState`).

---

## 5b. Defects found in OUR app during the live baseline walk

Captured against `v1.45.0` on `localhost:10254`, signed in, freshly-seeded instance (1 org, 1 project, 1 agent, 0 connections). Independent of parity — these are bugs to fix regardless.

| #   | Defect                                                                                                                                                                                                                  | Route                 | Severity            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------- |
| 1   | **Install page renders the full 64-char API key in cleartext**, while `/overview` and `/settings/api-keys` mask the same key. We have the _same leak the paid product has._                                             | `/install`            | **High — security** |
| 2   | Empty state "No rules yet…" renders **above a populated `DEFAULT` row** — the table claims to be empty while showing a row. _(Note: the paid product does this too — we appear to have copied it. It's wrong in both.)_ | `/policy`             | Medium              |
| 3   | Page `<title>` is bare "OneCLI"; every other route sets a specific title                                                                                                                                                | `/activity`           | Low                 |
| 4   | ~12 app logos render as empty grey squares on first paint; fill in on reload. Not cached/preloaded, so first visit looks broken                                                                                         | `/connections`        | Medium              |
| 5   | `/connections/apps` redirects to `/connections` while every sibling tab keeps its own URL                                                                                                                               | `/connections/apps`   | Low                 |
| 6   | Breadcrumb reads `Api keys` (bad casing) while the heading reads `API Keys` — **the same auto-title-casing bug the paid app has**                                                                                       | `/settings/api-keys`  | Low                 |
| 7   | Email field renders its value as placeholder-grey, so it reads as an empty field                                                                                                                                        | `/settings/profile`   | Low                 |
| 8   | Title is plural "API Keys" but the page shows a single key card with no create/name/scope/expiry                                                                                                                        | `/settings/api-keys`  | Low                 |
| 9   | Tab label "External Vaults" vs route/breadcrumb "Vaults"                                                                                                                                                                | `/connections/vaults` | Low                 |

**Empty-state inconsistency (confirms slice I):** three variants coexist in our app — boxed + icon + title + body (`/groups`, `/team`), boxed + centered text only (`/connections/custom`, `/llms`), and unboxed plain text (`/connections/budgets`).

**Action-button placement is inconsistent:** own row below the header (`/projects`, `/agents`, `/groups`), inline with a filter toolbar (`/policy`), dropdown in the header row (`/install`), none (`/overview`, all settings).

---

## 6. Proposed work slices

Sequenced to avoid file collisions. **Slice A is a hard prerequisite for everything else.**

| Slice                              | Scope                                                                                                                                                                                                                                                                                                   | Primary files                                                                                                  | Parallel-safe?                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **A. Nav shell split**             | Two shells (org/project), `‹ All projects` back link, breadcrumb w/ org + plan badge. **Pre-registers all new nav entries pointing at placeholder pages** so later slices never touch nav config.                                                                                                       | `lib/nav-config.ts`, `dashboard-sidebar.tsx`, `nav-main.tsx`, `dashboard-header.tsx`, `(dashboard)/layout.tsx` | ❌ Must run first, alone                                          |
| **B. Projects card grid**          | Table → card grid                                                                                                                                                                                                                                                                                       | `projects/_components/*`                                                                                       | ✅                                                                |
| **C. Global Connections**          | Org-scope Apps/Custom/LLMs                                                                                                                                                                                                                                                                              | new `(dashboard)/global-connections/*`, shared bits from `connections/_components`                             | ⚠️ Shares components w/ project connections — assign one dev only |
| **D. Usage page**                  | Stat cards + usage-by-agent table. **No plan strip, no quota grid, no upgrade CTAs** — no tiers exist. **Needs a new aggregate endpoint** — `/v1/counts` is per-project _inventory_, not requests; budgets meter dollars per LLM secret with no agent or request dimension. Neither can back this page. | new `(dashboard)/usage/*`                                                                                      | ✅                                                                |
| ~~**E. Billing page**~~            | **DROPPED** — no plan tiers                                                                                                                                                                                                                                                                             | —                                                                                                              | —                                                                 |
| ~~**F. App Availability**~~        | **DROPPED** — pure upsell, no feature behind it                                                                                                                                                                                                                                                         | —                                                                                                              | —                                                                 |
| **G. Org Settings: Domains + SSO** | UI shells. **No lock-gated actions** — available to all orgs                                                                                                                                                                                                                                            | new `settings/domains/*`, `settings/sso/*`                                                                     | ✅                                                                |
| **H. Members restyle**             | `/team` → Members label, badges, footer count, split Invite button                                                                                                                                                                                                                                      | `team/_components/*`                                                                                           | ✅                                                                |
| **I. Design-system pass**          | Extract `EmptyState`, table wrapper, uppercase table headers, dashed empty-state variant                                                                                                                                                                                                                | `packages/ui/src/components/*`                                                                                 | ⚠️ Run last — touches everything                                  |

**Scope decision needed:** Usage and Billing are UI-heavy but need real metering and Stripe data behind them. Recommend **UI shell + gating hooks, wired to whatever `/v1/counts` and budget data already exists; no payment integration** unless Marco says otherwise.
