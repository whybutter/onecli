# Paid Product — PROJECT Scope UI Spec

> **Source:** transcribed from screenshots in `/Users/marco/Projects/ai-agents/onecli-paid-screenshots` (files `16-*` through `24-*`).
> **This describes the competitor's paid product (app.onecli.sh), NOT our current app.** It is a parity target, not a description of what we have.
>
> ⚠️ **The screenshot folder contains live credentials.** `17-project-install.png` shows an unmasked project API key. Do not commit that folder, and do not transcribe the key anywhere. It should be rotated.

Captured account: organization **Binnacle** (plan badge **Pro**), single project **Binnacle**. Screenshots are chromeless, so routes are inferred from breadcrumbs — the breadcrumb leaves are clearly derived from URL segments (note the auto-title-cased `Llms` and `Vaults`, which betray the raw slugs).

---

## 0. Global chrome present on every project screen

### 0.1 Top bar

Left → right:

1. **Logo**: `>>` chevron mark (green) + wordmark **onecli** (black), top-left inside the sidebar column.
2. **Org switcher affordance**: small stacked up/down chevron (⌃⌄) at the right edge of the sidebar header, beside the logo.
3. **Sidebar collapse toggle**: panel icon, first item right of the sidebar divider.
4. **Breadcrumb** (see §0.3).
5. Right icon cluster, in order: **docs/book**, **GitHub**, **Discord**, divider, **bell/notifications**, divider.
6. **Get Started** — solid **green** primary button with rocket icon. Label exactly `Get Started`.
7. **Theme toggle** — sun icon, far right.

### 0.2 Left sidebar (project scope)

- Top row: back link `‹ All projects` (chevron-left + text), above the nav list and visually separated from it.
- Nav items, in this exact order:
  1. `Overview` (grid icon)
  2. `Install` (download-tray icon)
  3. `Agents` (robot icon)
  4. `Connections` (plug icon)
  5. `Activity` (activity-pulse icon)
  6. `Project Settings` (gear icon)
- Active item: pale **green** rounded-rect background, **green** icon and label. Inactive: transparent bg, dark grey text.
- Sidebar footer, two blocks:
  - **Quota card** (bordered, rounded): `Agents` left, `3/3` right, full-width progress bar filled 100% **orange**, helper text `Upgrade for more agents`.
  - **User row**: circular `MR` avatar, bold name, muted email, stacked chevron selector on the right.

### 0.3 Breadcrumb pattern (project scope)

`Binnacle` `[Pro]` › `All projects` › `Binnacle` › `<Page>`

- Crumb 1 = org name + small pale-green `Pro` pill.
- Crumb 2 = `All projects` (links back to org projects list).
- Crumb 3 = project name.
- Crumb 4 = current page. Connections sub-tabs add a 5th crumb (`Connections` › `Custom` / `Llms` / `Vaults`).
- Separators are `›`. Leading crumbs muted grey, leaf black.

### 0.4 Content layout

Centered fixed-width column (~900px) with generous gutters, very light grey page background. Cards are white, 1px light border, ~10px radius.

---

## 1. Project Overview (`16-project-overview.png`)

**Route:** `/projects/<projectId>` or `/projects/<projectId>/overview`. Sidebar item 1. No tabs.

**Header:** Title `Overview` / subtitle `Your OneCLI dashboard at a glance.` No header actions.

**Content — four stacked blocks:**

**(a) API Key card**

- Title `API Key`, description `Your personal API key for this project.`
- Read-only monospace grey-filled input showing the **masked** key: `oc_c92••••••••••••8674` (prefix, bullet mask, last 4).
- Three icon-only ghost buttons right of the field: **eye** (reveal), **copy**, **circular-arrows** (regenerate).

**(b) Stat card row** — 4 equal cards. Each: label top-left, small outline icon top-right, big number, muted caption.

| Label     | Icon  | Value | Caption                 |
| --------- | ----- | ----- | ----------------------- |
| `Agents`  | robot | `3`   | `Configured agents`     |
| `Apps`    | grid  | `3`   | `Connected apps`        |
| `LLMs`    | brain | `1`   | `LLM keys`              |
| `Secrets` | key   | `10`  | `Encrypted credentials` |

**(c) Recent Activity card**

- Title `Recent Activity`, description `Latest requests from your gateway.`
- Top-right link `View all →`.
- 5 divider-separated rows. Columns left→right: relative time (muted) · method pill · provider · `·` · host (bold) + path (monospace muted) · optional key icon · vertical rule · status code · latency (right-aligned muted).
- Method pill: `POST` in a small rounded-full outline chip, monospace, black on white.
- Status `200` in plain dark text — no green/red coloring at this state.

---

## 2. Project Install (`17-project-install.png`)

**Route:** `/projects/<projectId>/install`. Sidebar item 2.

**Header:** Title `Install` / subtitle `Run your coding agent through OneCLI — credentials are injected at the gateway, never stored on your machine.`
Header right control, same baseline as title: muted label `Agent` + **select** showing `Helm (default)` with chevron-down. Parameterizes the commands below.

**Content — 3-step numbered vertical stepper.** Each step: circled step number in the left gutter connected by a vertical rule, bold title, muted one-line description, then content.

**Step 1 — `Choose your tool`**

- Description: `The commands below adapt to your pick.`
- Wrapping row of toggle chips (rounded rect, bordered), in order: `Claude Code`, `Cursor`, `Codex`, `Hermes`, `OpenCode`, then second line `OpenClaw`, `>_ Other` (last chip carries a terminal `>_` glyph).
- Selected chip (`Claude Code`): pale green fill, green border, dark text. Unselected: white, light grey border.

**Step 2 — `Install & sign in`**

- Description: `One command: installs the CLI and signs in to this project.`
- Code block (grey rounded panel, monospace, wraps to two lines, copy button top-right):

```
curl -fsSL "https://api.onecli.sh/v1/install/cli?key=oc_org_<REDACTED>&tool=claude-code" | sh
```

(redacted — the real capture shows the full unmasked key; see the security note below)

The `tool=` query param tracks the Step-1 chip selection.

**Step 3 — `Run it`**

- Description: `Launches Claude Code behind the gateway — proxy and CA are configured for you.` (tool name tracks the Step-1 selection)
- Code block with copy button: `onecli run -- claude`
- Helper line below, muted, command in inline monospace: `One-off identity switch: onecli run --agent ag-<agentId> -- claude`

**Setup status card** (separate bordered card below the stepper, same column width)

- Title `Setup status`
- Row: small **green** filled dot, then `Helm is live — ` followed by two green text links separated by a middle dot: `view activity` · `manage agent`.

### ⚠️ Security note — do NOT copy this pattern

The paid product **masks** the project API key on Overview (`oc_c92••••8674`) but **prints it unmasked** in the Install command, and embeds it in a shareable install URL as a query parameter. That is a credential-leak pattern on three counts:

1. The key is rendered in plaintext in the UI, so any screenshot of the Install page leaks it — which is exactly what happened in this screenshot set.
2. Putting the key in a URL **query string** means it lands in server access logs, proxy logs, and browser history.
3. The install URL is inherently copy-pasteable and shareable, so the key travels with it.

**For our implementation:** mask the key by default with an explicit reveal action, and prefer a **short-lived, single-use install token** over the long-lived project key. If a key must appear in the command, pass it via a header or stdin rather than a query parameter.

---

## 3. Project Agents (`18-project-agents.png`)

**Route:** `/projects/<projectId>/agents`. Sidebar item 3.

**Header:** Title `Agents` / subtitle `Manage agents that connect to the gateway and receive injected credentials.`
Primary action right-aligned on its own line **below** the header (not inline with the title): `+ Create Agent` — solid **black**, white text, leading plus icon.

**Content** — vertical list of full-width white cards (one per agent), ~12px gap, no table headers.

Card left block:

- Agent name (bold, ~15px). The default agent carries a pill badge to the right of the name reading `Default` (white pill, light grey border, dark text).
- Second line, inline metadata: agent ID in a grey monospace chip (`ag-<timestamp>-<suffix>`) · `Last seen 15h ago` · `Created 7/13/2026` · key icon + `Credential access`.

Card right block, in order:

- **Overlapping avatar stack** of accessible credentials/apps: circular app-logo tokens, then key-glyph circles, ending in an overflow counter chip (`+8`, `+6`).
- `Manage` — ghost/text button with sliders icon.
- `⋯` — icon-only overflow menu.

Three agents present (`Helm` default, `Bridge`, `Beacon`). The list count (3) equals the sidebar quota `Agents 3/3` — i.e. Create Agent is at the plan cap.

---

## 4. Project Connections — shared shell

**Routes:** `/projects/<id>/connections`, `/connections/custom`, `/connections/llms`, `/connections/vaults`. Sidebar item 4, active for all four.

Breadcrumbs: Apps has no 5th crumb (it is the index tab); the others append `Custom` / `Llms` / `Vaults`.

**Header (identical on all tabs):** Title `Connections` / subtitle `App integrations, custom secrets, LLM keys, and external vaults.` No header buttons — per-tab action buttons sit under the tab bar.

**Tab bar** — underlined text tabs, left aligned: `Apps`, `Custom`, `LLMs`, `External Vaults`. Active = black text + black 2px underline; inactive = muted grey. Far right of the same row: a status/filter control reading `Connected` with a count chip `14` (small grey rounded chip). Constant across tabs; equals 3 apps + 1 LLM key + 10 custom secrets.

### 4a. Connections → Apps (`19-*`)

- **Category filter chips**: `All` (selected — solid **black** pill, white text), then outline pills `Development`, `Google`, `Microsoft`, `Project Management`, `Cloud & Data`, `Communication`.
- Right of the chips: **search input** with magnifier, placeholder `Search...`.
- **3-column card grid.** First cell is a dashed-border CTA tile: `+` square icon, title `Request an app`, subtitle `We'll add it for you`.
- Every other tile: square app logo, app name (bold), muted link line `View details`, a `›` chevron, a vertical divider, then either a solid **black** `Connect` button, or **green** text `Connected` — with a muted second line `2 accounts` where multiple accounts exist.
- **Connected apps are hoisted to the top** of the grid.

Catalog order (after the Request tile): Gmail, GitHub, GitHub App, GitLab, Google Drive, Google Calendar, Google Chat, Google Contacts, Resend, Google Admin, Google Analytics, Google Classroom, Google Docs, Google Forms, Google Meet, Google Photos, Google Search Console, Google Sheets, Google Slides, Google Tasks, Notion, Jira, Confluence, Todoist, Cloudflare, Fly.io, Dropbox, AWS, monday.com, MongoDB Atlas, Supabase, LinkedIn, Trello, Vercel, JFrog Artifactory, Datadog, Outlook Mail, Outlook Calendar, Microsoft Word, Microsoft OneNote, AWS Role, Affinity, Zoom, Sentry, HubSpot, Granola, Linear, Attio, X, Fathom, Slack, Fireflies, Zoho CRM.

The `›` chevron and the `View details` text both point at a detail drawer/route not captured.

### 4b. Connections → Custom (`20-*`)

- Action row: right-aligned solid **black** `+ Add Secret`.
- Vertical list of white cards, one per secret:
  - Line 1: secret name (bold) + type badge pill `Generic Secret` (white pill, grey border, dark text).
  - Line 2 (muted, monospace grey chips for values): `Host:` `<host>` — optionally `Path:` `<path>` — `Header` `<header-name>`.
  - Line 3: `Created M/D/YYYY` (muted, smaller).
  - Right: two icon-only ghost buttons — **pencil** (edit), **trash** (delete). Trash is neutral grey, **not** red.
- The `Path:` field is **omitted entirely** from the metadata line when unset — not rendered as empty.
- 10 items captured, matching the Overview `Secrets 10` stat.

### 4c. Connections → LLMs (`21-*`)

- Action row: right-aligned solid **black** `+ Add LLM Key`.
- One card, same anatomy as Custom: name `Anthropic Token` + badge pill `Anthropic API Key` (**provider-specific** badge text, not `Generic Secret`), `Host:` `api.anthropic.com`, no Path/Header line, `Created 7/13/2026`, pencil + trash buttons.
- Count of 1 matches the Overview `LLMs 1` stat.

### 4d. Connections → External Vaults (`22-*`)

- No action button row. A 2-card grid (~290px wide, side by side, left aligned).
- **Card 1**: title `Bitwarden` + pill badge `Beta`. Body: `Access credentials from your Bitwarden vault. The gateway fetches secrets at request time. Nothing is stored.` Full-width solid **black** `Connect`.
- **Card 2**: title `1Password` + pill badge `Beta`. Body: `Resolve secrets from 1Password with a service account. The gateway fetches them at request time. Nothing is stored.` Full-width solid **black** `Connect`.
- Card titles are indented — an icon slot appears reserved/empty at the left of the title row.

---

## 5. Project Activity (`23-project-activity.png`)

**Route:** `/projects/<projectId>/activity`. Sidebar item 5. Also the `View all →` target from Overview and the `view activity` link on Install.

**Header:** Title `Activity` / subtitle `Request logs from your gateway. Bodies and query strings are never recorded.` No header buttons.

**Filter row:** segmented control (grey pill container) with three segments: `All` (selected — white raised segment, dark text), `Hide AI`, `Blocked`.
Right of it: a **Live** status pill — white bordered pill, small **green** waveform/broadcast icon, label `Live`.

**Table** in a bordered card, sticky header row. Columns left→right:

| #   | Column     | Alignment | Content                                                                                   |
| --- | ---------- | --------- | ----------------------------------------------------------------------------------------- |
| 1   | `Time`     | left      | relative, muted (`15h ago`)                                                               |
| 2   | `Agent`    | left      | agent name                                                                                |
| 3   | `Method`   | left      | method chip (rounded-full outline, monospace)                                             |
| 4   | `Endpoint` | left      | two lines — host bold dark over path muted monospace                                      |
| 5   | `Provider` | right-ish | provider name, optionally followed by a small key glyph indicating an injected credential |
| 6   | `Status`   | left      | `200`, plain dark text                                                                    |
| 7   | `Decision` | left      | **empty for every visible row** — populated only for policy allow/block decisions         |
| 8   | `Latency`  | right     | `76ms`, `132ms`, …                                                                        |

Hairline dividers between rows. Table continues past the fold (page scrolls); no pagination control visible. Rows appear clickable — a detail drawer is implied but not shown.

---

## 6. Project Settings (`24-project-settings.png`)

**Route:** `/projects/<projectId>/settings`. Sidebar item 6.

**Header:** Title `Project Settings` / subtitle `Rename or delete this project. Billing and usage are in the sidebar under your organization.` No header buttons.

**Content — three stacked full-width cards:**

**(a) Project name**

- Title `Project name`, description `Shown in the sidebar, breadcrumb, and project list.`
- Field label `Name`, single-line text input, full card width, current value populated.
- Footer right-aligned: `Save changes` in a **disabled** state (grey fill, greyish-white text) because the value is unchanged.

**(b) Project access**

- Title `Project access`, description `Upgrade to the Team plan to share this project with your teammates.`
- Right-aligned solid **black** `Upgrade to Team`.
- Plan-gated — on a Team plan this presumably becomes a member/sharing list.

**(c) Delete project — danger zone**

- Card has a **red/rose 1px border**, distinct from other cards.
- Title `Delete project`, description `Permanently removes this project and all of its agents, secrets, connections, rules, and audit logs. You can't delete the only project in the organization.`
- Right-aligned `Delete project` — filled **muted/light red** (disabled-looking), consistent with the "can't delete the only project" rule being enforced at the button level.
- A delete-confirmation dialog is implied but not captured.

---

# Consolidated: scope model, navigation, org-vs-project differences

## A. How project scope is entered and switched

1. **Org scope is the default shell.** Its sidebar: `Projects`, `Global Connections`, `Global Policy`, then a separated group `Members`, `Groups`, `App Availability`, `Usage`, `Billing`, `Organization Settings`. Its breadcrumb is only two crumbs.
2. **Entry point** is the org `Projects` page. Project cards in a grid: folder icon, project name, meta line `3 agents · 14 resources`, owner line with avatar + `Owned by <name>`, and a `⋮` overflow menu. Clicking a card enters project scope.
3. **Once in project scope the entire sidebar is replaced** with the project nav, and a `‹ All projects` back link is prepended. There is **no persistent project switcher dropdown** — switching projects means going back to `All projects` and picking another card. The chevron beside the logo is the _org_ switcher; the chevron at the bottom user row is the account menu.
4. **Breadcrumb grows from 2 to 4–5 crumbs** in project scope. The org crumb and `All projects` crumb are the escape hatches.
5. **URL shape (inferred):** org pages are flat (`/projects`, `/connections`, `/policy`, `/members`, …); project pages nest under the project id — `/projects/<projectId>/{overview|install|agents|connections[/custom|/llms|/vaults]|activity|settings}`. Evidence: only project pages produce 4–5 crumbs, and the Connections sub-tab crumbs render raw slug titles (`Llms`, `Vaults`) rather than the tab labels (`LLMs`, `External Vaults`).

## B. Project-level navigation structure

| #   | Sidebar item     | Sub-tabs                                                     | Header title / subtitle                                                                                                     |
| --- | ---------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Overview         | —                                                            | `Overview` / `Your OneCLI dashboard at a glance.`                                                                           |
| 2   | Install          | in-page selectors: `Agent` select + `Choose your tool` chips | `Install` / `Run your coding agent through OneCLI — credentials are injected at the gateway, never stored on your machine.` |
| 3   | Agents           | —                                                            | `Agents` / `Manage agents that connect to the gateway and receive injected credentials.`                                    |
| 4   | Connections      | `Apps` · `Custom` · `LLMs` · `External Vaults`               | `Connections` / `App integrations, custom secrets, LLM keys, and external vaults.`                                          |
| 5   | Activity         | segmented filter `All` · `Hide AI` · `Blocked`               | `Activity` / `Request logs from your gateway. Bodies and query strings are never recorded.`                                 |
| 6   | Project Settings | —                                                            | `Project Settings` / `Rename or delete this project. Billing and usage are in the sidebar under your organization.`         |

## C. Project scope vs org scope, where both exist

**Connections** (org: "Global Connections", sidebar item 2; project: "Connections", sidebar item 4)

| Aspect                | Org / Global Connections                                                                                                                                                            | Project Connections                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Title                 | `Global Connections`                                                                                                                                                                | `Connections`                                                                                                    |
| Subtitle              | `Organization-wide app integrations, custom secrets, and LLM keys shared across all projects.`                                                                                      | `App integrations, custom secrets, LLM keys, and external vaults.`                                               |
| Tabs                  | `Apps`, `Custom`, `LLMs` — **3 tabs**                                                                                                                                               | `Apps`, `Custom`, `LLMs`, `External Vaults` — **4 tabs**; External Vaults exists **only at project level**       |
| Right-of-tabs control | `Connected`, no count                                                                                                                                                               | `Connected` with count chip `14`                                                                                 |
| Breadcrumb leaf       | generic `Dashboard`, unchanged across tabs                                                                                                                                          | tracks the sub-tab                                                                                               |
| Apps filters/search   | identical                                                                                                                                                                           | identical                                                                                                        |
| `Request an app` tile | present, first cell, same copy                                                                                                                                                      | present, first cell, same copy                                                                                   |
| Apps card ordering    | natural catalog order                                                                                                                                                               | **connected apps hoisted to the top**, then catalog order with the hoisted ones removed from their natural slots |
| Apps connection state | every app shows `Connect`                                                                                                                                                           | mixed — green `Connected` (+ `2 accounts` sub-line) vs black `Connect`                                           |
| Custom tab            | **empty state**: key icon in grey circle, `No custom secrets yet`, `Add a custom secret to inject encrypted credentials into gateway requests.` `+ Add Secret` still shown above it | populated list of 10 secret cards; same button, same card anatomy                                                |
| LLMs tab              | **empty state**: `No LLM keys yet`, `Add an LLM API key to route requests through the gateway.`                                                                                     | one populated card; same button                                                                                  |
| Semantics             | credentials shared across **all** projects                                                                                                                                          | credentials scoped to this project only                                                                          |

**Org-only** (no project equivalent): `Global Policy`, `Members`, `Groups`, `App Availability`, `Usage`, `Billing`, `Organization Settings`. Project Settings explicitly points at this split: _"Billing and usage are in the sidebar under your organization."_

**Project-only** (no org equivalent): `Overview`, `Install`, `Agents`, `Activity`, the `External Vaults` tab, `Project Settings`.

**Rules/policy asymmetry:** the Delete-project copy names "agents, secrets, connections, **rules**, and audit logs" as project-owned, yet there is no `Rules` item in the project sidebar. Rules appear to be _authored_ under org `Global Policy` while being _stored_ per project. Worth confirming before we model this.

## D. Design tokens observed (for matching)

- **Brand green:** `Get Started` fill, active sidebar item text + pale-green background, `Pro` badge, `Connected` status text, live indicator, Install "is live" dot, selected tool chip.
- **Neutral primary action:** solid **black** buttons — `Create Agent`, `Add Secret`, `Add LLM Key`, `Connect`, `New project`, `Upgrade to Team`, and the selected `All` filter chip. Green is never used for ordinary primary actions.
- **Danger:** rose card border + muted-red `Delete project` button. Per-row trash icons are neutral grey, not red.
- **Warning/quota:** orange progress bar in the sidebar `Agents 3/3` card.
- **Badges:** `Default`, `Generic Secret`, `Anthropic API Key`, `Beta` are all neutral white pills with light grey border. `Pro` is the only tinted badge.
- **Monospace** is used for: API keys, agent IDs, hosts, paths, header names, HTTP methods, and code blocks.
