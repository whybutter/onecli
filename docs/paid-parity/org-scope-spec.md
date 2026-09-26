> **About this document**
>
> Transcribed verbatim from the screenshots in `/Users/marco/Projects/ai-agents/onecli-paid-screenshots`
> (files `01-global-policy.png` through `15-settings-encryption.png`, 17 captures total).
>
> **This describes the competitor's paid product, not our current app.** It is a reference
> transcription for parity work — nothing here reflects what OneCLI ships today. Observations about
> apparent bugs in the captured product (breadcrumbs reading "Dashboard", the `Sso` / `Org api keys`
> mis-casing, the partially-rendered sidebar in two captures) are preserved as recorded.

# OneCLI Cloud (app.onecli.sh) — Organization / Global Scope UI Spec

Source: 17 screenshots at `/Users/marco/Projects/ai-agents/onecli-paid-screenshots/`. Org in the captures is **Binnacle** on the **Pro** plan; signed-in user is Marco Rivadeneyra (marco@simbiosis.team).

No address bar is visible in any capture, so routes are inferred from breadcrumbs only. Breadcrumb trails are noted verbatim (including what look like casing bugs, e.g. `Sso`, `Org api keys`).

---

## Global chrome (present on every screen)

### Left sidebar (fixed, ~210px, light gray-white `#fafafa`-ish, 1px right border)

Top: wordmark **`>> onecli`** — the `>>` chevrons are green, `onecli` is near-black. At the far right of that row is a small **up/down chevron control** (⌃⌄ stacked), i.e. an org switcher affordance attached to the logo row.

Nav items (icon + label, in this exact order, with a visual group break after "Global Policy"):

| #   | Label                     | Icon             |
| --- | ------------------------- | ---------------- |
| 1   | Projects                  | folder           |
| 2   | Global Connections        | plug / connector |
| 3   | Global Policy             | shield           |
| —   | _(gap / group separator)_ |                  |
| 4   | Members                   | two people       |
| 5   | Groups                    | people           |
| 6   | App Availability          | 2×2 grid         |
| 7   | Usage                     | bar chart        |
| 8   | Billing                   | credit card      |
| 9   | Organization Settings     | gear             |

Active item styling: **pale green pill background** spanning the item, **green icon and green label text**. Inactive: gray icon, near-black label, no background. (In `01-global-policy.png` the active pill appears slightly lighter/outlined vs. the solid pale-green in others — likely a hover vs. active variant.)

Sidebar footer, two stacked blocks:

1. **Quota card** (bordered, rounded, white): row with bold `Agents` on the left and `3/3` on the right (gray, small). Below it a **full-width progress bar filled 100% in orange/amber**. Below that, small gray text: `Upgrade for more agents`.
2. **User card**: circular gray avatar with initials `MR`, then two lines — bold `Marco Rivadeneyra` and gray `marco@simbiosis.team` — with a stacked up/down chevron control on the right (user menu / account switcher).

> Note: in `07-groups.png` and `14-settings-api-keys.png` the sidebar renders **only "Projects"** (items 2–9 missing) while the footer quota/user cards still render. This looks like a nav-loading/permission-hydration state rather than a distinct design.

### Top bar (full width right of sidebar, white, 1px bottom border, ~52px)

- Far left: **panel-collapse icon** (square with left rail), then a thin vertical divider.
- **Breadcrumb**: `Binnacle` + a small **`Pro` pill** (pale green background, green text, rounded) → chevron `>` → current page segment.
  - Observed trails: `Binnacle Pro > Dashboard` (Global Policy, Global Connections all tabs, App Availability), `Binnacle Pro > All projects`, `Binnacle Pro > Members`, `Binnacle Pro > Groups`, `Binnacle Pro > Usage`, `Binnacle Pro > Billing`, `Binnacle Pro > Organization Settings > General | Domains | Sso | Org api keys | Encryption`.
  - The org name segment is likely the org switcher trigger.
- Far right, in order: **book/docs icon**, **GitHub icon**, **Discord icon**, thin divider, **`Get Started` button** (solid green, white text, rocket/sparkle icon on the left), **theme toggle** (sun icon).

### Content area

White background, content is **centered in a fixed-ish column** roughly 900px wide (left edge ~x=434 of 1568) for the main pages; the Organization Settings screens shift the column right to make room for the settings sub-nav.

---

## 1. Global Policy — `01-global-policy.png`

**Nav:** sidebar item 3 "Global Policy". **Breadcrumb:** `Binnacle Pro > Dashboard` (breadcrumb does not reflect the page — appears to be a bug).

**Header**

- Title: **Global Policy** (large, bold, ~28px)
- Subtitle: `These guardrails apply to every project in your organization — the strictest matching rule decides each request.` (gray, em-dash)

**Toolbar row** (below header, spans the content column)

- Left: **search input** with magnifier icon, placeholder `Filter rules...` (~210px wide, rounded, light border)
- Next to it: **info icon (ⓘ) + link text** `How rules are evaluated` (gray/dark, looks like a text link or popover trigger)
- Right side, two buttons:
  - `Apply Changes` — **secondary/ghost, appears disabled** (gray text), with a cloud-upload icon
  - `Add Rule` — **primary, solid black, white text**, leading `+` icon
- Below the toolbar, right-aligned small gray text: `Last applied by System · 21d ago`

**Main content — card** (white, rounded, 1px border)

- Card header row: small building/org icon + bold **`Organization rules`**
- Table header (uppercase, small, letter-spaced, gray): `PRIORITY` | `NAME` | `APPLIES TO` | `TARGET` | `ACTION`
- Empty body row, centered gray text: `No rules yet. Add your first rule to get started.`
- **Pinned default row below the empty state** (separated by a hairline rule):
  - PRIORITY: `DEFAULT` (uppercase, small, gray)
  - NAME: `Default Rule` (bold)
  - APPLIES TO: people icon + `All agents`
  - TARGET: `Any`
  - ACTION: a **segmented two-option control** — `Allowed` (green check-circle icon, green text, **selected** — light gray/white pill background) and `Blocked` (red shield-slash icon, red text, unselected). Rendered as an inline toggle group, not a dropdown.

No modals or dropdowns open.

---

## 2. Projects — `02-projects.png`

**Nav:** sidebar item 1 "Projects". **Breadcrumb:** `Binnacle Pro > All projects`.

**Header**

- Title: **Projects**
- Subtitle: `Each project has its own agents, secrets, connections, and rules.`
- Primary action, top-right of the content column: `New project` — solid black button, leading `+`.

**Main content — card grid** (3 columns implied; one card present, ~290px wide)

- Card (white, rounded, 1px border):
  - Left: rounded-square light-gray tile with a **folder icon**
  - Title: **Binnacle** (bold)
  - Meta line (gray, small): `3 agents · 14 resources` (middle-dot separator)
  - Footer line: tiny circular avatar `MR` + gray text `Owned by Marco Rivadeneyra`
  - Top-right of card: **vertical ⋮ overflow menu** (closed)

---

## 3. Global Connections — Apps tab — `03-global-connections-apps.png` + `-scrolled.png`

**Nav:** sidebar item 2 "Global Connections". **Breadcrumb:** `Binnacle Pro > Dashboard`.

**Header**

- Title: **Global Connections**
- Subtitle: `Organization-wide app integrations, custom secrets, and LLM keys shared across all projects.`

**Tab bar** (underline style, sits directly under the header, full content width, 1px bottom border):

- Left group: `Apps` | `Custom` | `LLMs` — the active tab has **bold near-black text and a 2px dark underline**; inactive tabs are gray with no underline.
- **Right end of the same bar: `Connected`** (gray text, no underline) — a right-aligned tab/filter for showing only connected integrations.

**Filter row** (Apps tab only)

- Left: **category chips**, rounded pills: `All` (selected — solid dark/black fill, white text), then unselected (light gray fill, dark text): `Development`, `Google`, `Microsoft`, `Project Management`, `Cloud & Data`, `Communication`
- Right: **search input** with magnifier, placeholder `Search...` (~165px)

**App grid** — 3 columns, each cell a white rounded bordered card ~294×48px, laid out as: app logo (left, ~20px), app name (bold, small), `View details` (gray, tiny, second line), a `>` chevron, then a **`Connect` button** (small, solid black, white text, pill/rounded-rect) at the right edge.

First cell of the grid is a special **"request" tile** (light gray fill, dashed/soft, no Connect button): `+` icon in a rounded square, bold `Request an app`, gray sub-line `We'll add it for you`.

Apps in visual order, reading left→right by row:

| Row | Col 1            | Col 2         | Col 3                 |
| --- | ---------------- | ------------- | --------------------- |
| 1   | _Request an app_ | Gmail         | GitHub                |
| 2   | GitHub App       | GitLab        | Google Drive          |
| 3   | Google Calendar  | Google Chat   | Google Contacts       |
| 4   | Resend           | Google Admin  | Google Analytics      |
| 5   | Google Classroom | Google Docs   | Google Forms          |
| 6   | Google Meet      | Google Photos | Google Search Console |
| 7   | Google Sheets    | Google Slides | Google Tasks          |
| 8   | Notion           | Jira          | Confluence            |

Scrolled capture (later rows; there is an unseen gap between "Notion/Jira/Confluence" and "Todoist/Cloudflare/Fly.io"):

| Col 1          | Col 2             | Col 3             |
| -------------- | ----------------- | ----------------- |
| Todoist        | Cloudflare        | Fly.io            |
| Dropbox        | AWS               | monday.com        |
| MongoDB Atlas  | Supabase          | LinkedIn          |
| Trello         | Vercel            | JFrog Artifactory |
| Datadog        | Outlook Mail      | Outlook Calendar  |
| Microsoft Word | Microsoft OneNote | AWS Role          |
| Affinity       | Zoom              | Sentry            |
| HubSpot        | Granola           | Linear            |
| Attio          | X                 | Fathom            |
| Slack          | Fireflies         | Zoho CRM          |

Every card except the request tile shows the identical `View details` + `>` + `Connect` treatment — no per-app state variation (no "Connected" chips) in these captures. All logos are full-color vendor marks.

---

## 4. Global Connections — Custom tab — `04-global-connections-custom.png`

Same header, same tab bar with `Custom` active (bold + underline). No category chips or search on this tab.

- **Action row:** right-aligned `+ Add Secret` — solid black button.
- **Empty state card** (white, rounded, 1px border, ~230px tall, centered content):
  - Circular light-gray badge containing a **key icon**
  - Bold: `No custom secrets yet`
  - Gray body, two lines, centered, narrow measure: `Add a custom secret to inject encrypted credentials into gateway requests.`

---

## 5. Global Connections — LLMs tab — `05-global-connections-llms.png`

Same header/tab bar with `LLMs` active.

- **Action row:** right-aligned `+ Add LLM Key` — solid black button.
- **Empty state card** (identical construction to Custom):
  - Circular gray badge with **key icon**
  - Bold: `No LLM keys yet`
  - Gray body: `Add an LLM API key to route requests through the gateway.`

---

## 6. Members — `06-members.png`

**Nav:** sidebar item 4. **Breadcrumb:** `Binnacle Pro > Members`.

**Header**

- Title: **Members**
- Subtitle: `Manage members and roles for your organization.`
- Primary action (top-right): **split button** — `Invite` (solid black, leading person-plus icon) joined to a **caret dropdown segment** (▾) on its right.

**Upgrade banner** (full-width, light gray/off-white fill, rounded, no strong border)

- Text (2 lines, dark): `Your team is growing! Upgrade to the Team plan to unlock advanced roles, 30-day audit logs, and unlimited projects.`
- Right: `Upgrade to Team` — solid black button.

**Members table** (white card, rounded, 1px border)

- Header row (uppercase, small, gray): `MEMBER` | `ROLE` (role column starts ~x=1128; a third unlabeled column at the far right holds row actions)
- Rows (hairline separators, ~46px tall):

| Avatar           | Member                   | Badge                                                                                             | Role                                | Row action          |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------- |
| `MR` gray circle | `marco@binnacle.com.mx`  | —                                                                                                 | `Owner`                             | _(none)_            |
| `MR` gray circle | `marco@simbiosis.team`   | **`YOU`** — small uppercase pill, light gray fill, gray text                                      | `Admin`                             | vertical `⋮` menu   |
| `H` gray circle  | `hanaya@binnacle.com.mx` | **`INVITED`** — small uppercase pill, **pale amber/yellow fill with amber text and amber border** | `Admin` (gray/muted vs. the others) | `×` (remove/revoke) |

- Table footer row (gray, small, left-aligned): `3 members`

Role values are plain text here (no visible select control), though the ⋮ menu presumably holds role change.

---

## 7. Groups — `07-groups.png`

**Nav:** sidebar item 5. **Breadcrumb:** `Binnacle Pro > Groups`.

**Header**

- Title: **Groups**
- Subtitle: `Organize members into groups — the building blocks for group-level access.`
- No page-level action button (actions live per section).

**Section 1 — Member groups**

- Section title (bold, ~16px): `Member groups`
- Section subtitle (gray): `Managed here or synced from your identity provider.`
- Right-aligned button: `+ New group` — solid black.
- Empty state (rounded rectangle with **dashed/very light border**, ~140px tall, centered):
  - Circular gray badge with **people icon**
  - Bold: `No groups yet`
  - Gray: `Create a group to organize members for group-level access.`

**Section 2 — Role mappings** (below, same construction)

- Title: `Role mappings`
- Subtitle: `Grant an org role to a group's members — the highest-priority mapping wins, owners are never changed.`
- Button: `+ New mapping` — solid black.
- Empty state:
  - Circular gray badge with **shield-check icon**
  - Bold: `No role mappings yet`
  - Gray: `Map a group to a role to manage members' access from your directory.`

---

## 8. App Availability — `08-app-availability.png`

**Nav:** sidebar item 6. **Breadcrumb:** `Binnacle Pro > Dashboard`.

**Header**

- Title: **App Availability**
- Subtitle: `Choose which apps each project may connect, based on who has access to it.`

**Main content — single upsell card** (white, rounded, 1px border, ~130px tall, left-aligned content)

- Bold: `App availability`
- Gray body: `Restrict which apps each project may connect based on who has access to it. This is an Enterprise feature.`
- Button: `Upgrade to Enterprise` — solid black, white text.

This is the entire page — the feature is fully gated behind the plan (no preview/disabled table).

---

## 9. Usage — `09-usage.png`

**Nav:** sidebar item 7. **Breadcrumb:** `Binnacle Pro > Usage`. Page scrolls (content continues below the fold).

**Header**

- Title: **Usage**
- Subtitle: `Track your plan usage and API requests.`

**Block 1 — Current plan strip** (rounded card, very light gray fill)

- Left: rounded-square icon tile with a **credit-card icon**
- Uppercase small gray label: `CURRENT PLAN`; below it bold **`Pro`** followed by gray `$25/mo`
- Right-aligned gray text: `Renews August 22, 2026`

**Block 2 — Quota card** (white, rounded, bordered)

- Header row: `**Pro** plan – quota limit reached` (the word "Pro" bold) on the left; right: `Upgrade →` button (secondary/outline, light, with trailing arrow)
- Body: **2-column × 3-row quota grid**, each cell = label + value on the left, a circular gauge on the right, separated by hairlines:

| Cell | Label             | Value                                        | Gauge                         |
| ---- | ----------------- | -------------------------------------------- | ----------------------------- |
| 1    | Projects          | `1 / Unlimited`                              | gray circle with **∞**        |
| 2    | Agents            | `3 / 3` (**value rendered in amber/orange**) | **amber ring, full/complete** |
| 3    | Secrets           | `11 / Unlimited`                             | ∞                             |
| 4    | OAuth apps        | `3 / Unlimited`                              | ∞                             |
| 5    | Integration calls | `0 / Unlimited`                              | ∞                             |
| 6    | Members           | `2 / Unlimited`                              | ∞                             |

**Block 3 — Two stat cards side by side** (equal width, white, rounded, bordered)

|                                     | Left card                     | Right card                           |
| ----------------------------------- | ----------------------------- | ------------------------------------ |
| Title (bold, small)                 | `Requests this period`        | `Integration calls`                  |
| Date range (top-right, gray, small) | `Jul 22, 2026 – Aug 22, 2026` | `Jul 22, 2026 – Aug 22, 2026`        |
| Big number (~32px bold)             | `99,244`                      | `52,638`                             |
| Caption (gray, small)               | `total gateway requests`      | `requests with credential injection` |

**Block 4 — Usage by agent table** (white card, partially below fold)

- Header row: bold `Usage by agent` on the left; right-aligned column headers `Requests` and `Integration calls` (small, gray)
- Rows: agent name (bold-ish, left) + a **horizontal proportional bar** (green fill on a light gray track, sized to share of requests) + right-aligned numbers:

| Agent  | Bar                        | Requests | Integration calls |
| ------ | -------------------------- | -------- | ----------------- |
| Helm   | long green bar (~dominant) | `95,429` | `49,425`          |
| Bridge | tiny sliver                | `2,455`  | `2,046`           |
| Beacon | tiny sliver                | `1,360`  | `1,167`           |

Content continues below the capture.

---

## 10. Billing — `10-billing.png`

**Nav:** sidebar item 8. **Breadcrumb:** `Binnacle Pro > Billing`.

**Header**

- Title: **Billing**
- Subtitle: `Manage your subscription and billing.`

**Billing-period toggle** (right-aligned, above the plan grid): a segmented control in a light gray track — `Monthly` (**selected**, white pill, dark text) and `Yearly` with a small green pill badge reading `2 months free`.

**Plan grid** — 4 equal-width cards side by side. The current plan card (**Pro**) has a **green border** and a **`Current` badge** (solid green, white text, small pill) centered on its top edge; the other three have a plain 1px gray border. Each card: plan name (bold) + parenthetical audience label (gray, same line), tagline (gray, small), price (~28px bold) + `/month` (gray), an included-agents line, a hairline, then a feature list, then the CTA at the bottom.

**Free**

- `Free` `(Get Started)` / `For personal use`
- `$0` `/month` / `Free forever`
- Features (first item has a link/chain icon + ⓘ; the rest have green checkmarks):
  - `2 agents included` ⓘ
  - `3 human seats` + **`Included` badge** (pale green pill, green text)
  - `500 integration calls/mo`
  - `1 project` ⓘ
  - `10 secrets`
  - `3 OAuth app connections`
  - `Block rules`
  - `1-day audit logs`
  - `Community support`
- Footer: plain centered gray text `Included in your plan` (no button)

**Pro** — current

- `Pro` `(Small Projects)` / `For developers shipping agents to production`
- `$25` `/month` / `3 agents included`
- Features: `3 agents included` ⓘ · `Unlimited human seats` + `Included` badge · `Unlimited integration calls` · `Unlimited projects` ⓘ · `Unlimited secrets` · `Unlimited OAuth apps` · `Rate limit + block rules` · `7-day audit logs` · `Email support`
- CTA: `Manage Subscription` — **outline/secondary** button, full width

**Team**

- `Team` `(Growing Teams)` / `For teams collaborating on agent infrastructure`
- `$199` `/month` / `20 agents included`
- Features: `20 agents included` ⓘ · `10 human seats` + `Included` badge · `Everything in Pro` · `Shared projects` ⓘ · `Approval workflows` · `30-day audit logs` · `Priority support`
- CTA: `Switch Plan →` — **solid black**, full width

**Scale**

- `Scale` `(Scaling Companies)` / `For companies running fleets of agents`
- `$499` `/month` / `50 agents included`
- Features: `50 agents included` ⓘ · `25 human seats` + `Included` badge · `Everything in Team` · `All policy rules` · `Dedicated Slack support` · `90-day audit logs` · `SLA`
- Extra note above the CTA (gray, small, 2 lines): `Self-hosted in your VPC? $1,499/mo. Talk to us`
- CTA: `Switch Plan →` — solid black

**Enterprise strip** (below the grid, full-width white card, rounded, bordered)

- Left: rounded-square light-gray tile with a **building icon**
- Bold: `Enterprise`
- Gray body: `Custom integrations, dedicated support, SLA guarantees, SSO/SAML, and VPC/on-premise deployment options for teams with advanced requirements.`
- Below: **`Contact Sales`** (bold dark text link with a trailing external-link ↗ icon)

---

## Organization Settings (screens 11–15)

Shared shell for all five: **Breadcrumb `Binnacle Pro > Organization Settings > <Segment>`**, sidebar item 9 active. The content area is split into a **settings sub-nav column** (left, ~180px, starting right after the main sidebar with a vertical divider at ~x=392 separating it from the page body) and the page body (centered right of it).

**Settings sub-nav**

- Group label (uppercase-ish small gray): `Organization`
- Items (icon + label), in order: `General` (building icon) · `Domains` (globe) · `Single sign-on` (fingerprint/SSO icon) · `API Keys` (key) · `Encryption` (shield-check)
- Active item: **pale green rounded pill, green icon + green text**; inactive: gray icon, dark text.

Note the breadcrumb leaf strings don't match the sub-nav labels: `General`, `Domains`, `Sso`, `Org api keys`, `Encryption`.

---

### 11. Settings → General — `11-settings-general.png`

- Title: **Organization**
- Subtitle: `Rename or delete your organization.`
- Section heading (bold, ~18px, outside the card): `Organization details`
- **Card** (white, rounded, bordered):
  - Field label `Organization name` → text input, full width, value **`Binnacle`** (populated, not placeholder)
  - Field label `Organization ID` → **read-only text input** with **gray/muted value** `czwulbqzfquczpaa`, paired to the right with a `Copy` button (outline/secondary, copy icon)
  - Hairline separator, then a right-aligned footer action row inside the card: `Cancel` (ghost, gray, disabled-looking) and `Save` (**solid but muted gray — disabled state**, since nothing changed)
- Despite the subtitle mentioning delete, **no delete/danger-zone section is visible** on this screen.

### 12. Settings → Domains — `12-settings-domains.png`

- Title: **Domains**
- Subtitle: `Claim your company's email domains and verify them via DNS — the foundation for single sign-on.`
- **Card**:
  - Label `Add a domain`
  - Row: text input with placeholder **`example.com`** (~310px) + `Add domain` button (**solid black**, leading **lock icon** — implying the action is plan-gated)
  - Helper text under the input (gray, small): `You'll prove ownership by publishing a DNS TXT record.`
  - **Empty state** inside the card (dashed-border rounded rect):
    - **globe icon** (plain, no circular badge here)
    - Bold: `No domains yet`
    - Gray: `Claim your company domain to enable SSO.`

### 13. Settings → Single sign-on — `13-settings-sso.png` + `-scrolled.png`

- Title: **Single sign-on**
- Subtitle: `Connect your identity provider so your team signs in with their company accounts.`

**Card 1 — connection setup**

- **Two selectable protocol tiles side by side** (radio-card pattern):
  - `SAML 2.0` (bold) / `Entra ID, Okta, and most enterprise IdPs.` — **selected: green border + very pale green fill**
  - `OpenID Connect` (bold) / `IdPs exposing an OIDC issuer with client credentials.` — unselected: gray border, white fill
- Label `Connection name` → text input (~310px) with placeholder **`Acme Okta`**
- Label `IdP metadata`, with a right-aligned link on the same line: **`Paste XML instead`** (gray, with a swap/paste icon) → full-width text input with placeholder **`https://login.microsoftonline.com/.../federationmetadata.xml`**
- Helper text: `From your IdP's SAML app: federation metadata URL or the downloaded metadata XML.`
- Button: `Create connection` — **solid black, leading lock icon** (plan-gated)

**Card 2 — Require single sign-on**

- Title row: **lock icon** + bold `Require single sign-on`
- Body (gray, 2 lines): `Everyone with an email on your verified domain must sign in through your identity provider. Members marked as break-glass exempt keep their other sign-in methods.`
- Right: **toggle switch, OFF** (gray track, knob left)

**Card 3 — SCIM provisioning**

- Title row: **lock icon** + bold `SCIM provisioning`; right-aligned button `Generate token` (outline/secondary)
- Body (gray): `Let your identity provider create, update, and deactivate members automatically. Paste the base URL and a token into your IdP's provisioning settings.`
- Label `SCIM base URL` → **read-only monospace field** on a light gray fill showing `https://api.onecli.sh/scim/v2`, with a **copy icon** at the right edge
- Empty state below (dashed rounded rect):
  - **key icon**
  - Bold: `No provisioning tokens yet`
  - Gray: `Generate a token to connect your IdP.`

### 14. Settings → API Keys — `14-settings-api-keys.png`

Breadcrumb leaf: `Org api keys`.

- Title: **API Keys**
- Subtitle: `Your personal organization-level API key for OneCLI services.`
- **Card**:
  - Bold: `Your Organization API Key`
  - Body with inline `code` chips: `Your personal organization-level key — it works across every project in this organization. Pass the target project with an `**`X-Project-Id`**` header.` (the code chip has a light gray fill and monospace font)
  - **Key field**: full-width input on light gray fill, **value hidden/blank (masked)**, followed by three icon buttons on its right: **eye** (reveal), **copy**, **circular-arrows** (regenerate/rotate)
  - Footer helper with a leading ⓘ icon: `Use with `**`Authorization: Bearer oc_org_...`**`and`**`X-Project-Id: <project-id>`**` headers.` (both fragments as monospace code chips)

Only one key exists (no table, no create/revoke list) — it's a single personal org key, not a key-management CRUD screen.

### 15. Settings → Encryption — `15-settings-encryption.png`

- Title: **Encryption**
- Subtitle: `Configure how your secrets are encrypted.`
- **Card**:
  - Bold: `Key Management`
  - Gray helper (no trailing period): `Select which Key Management System to use for encrypting your project data`
  - **Select/dropdown** (~310px, white, bordered, chevron-down on the right), current value **`Default OneCLI KMS`**
  - Button: `Save` — **muted gray = disabled** (no pending change), left-aligned below the select

---

# Consolidated observations

## Global navigation structure

**Three-level model:** Organization (this whole set of screens) → Project (`Projects` list drills into a project scope) → resources within a project. Everything here is org scope; project-scope screens are reached from the Projects card grid.

**Sidebar order** (single flat list, one visual group break):

1. Projects
2. Global Connections
3. Global Policy
   — break —
4. Members
5. Groups
6. App Availability
7. Usage
8. Billing
9. Organization Settings

The break separates _resources / policy_ from _administration_. `Organization Settings` is the only item that expands into a **second-level sub-nav inside the content area** (General, Domains, Single sign-on, API Keys, Encryption) rather than nesting in the sidebar.

**Org switcher:** the logo row carries a stacked up/down chevron; the breadcrumb also leads with the org name + plan pill, so both are plausible switcher triggers. **User menu:** the bottom-left user card (`MR` avatar, name, email, stacked chevrons).

**Persistent upsell surfaces:** sidebar agent-quota meter (`Agents 3/3`, orange, "Upgrade for more agents"), the top-bar green `Get Started` CTA, the Members upgrade banner, the Usage quota card's `Upgrade →`, and the fully gated App Availability page. The product leans hard on inline plan gating — locked features show a lock icon on the action button (Domains "Add domain", SSO "Create connection") rather than being hidden.

**Top bar** is constant: collapse toggle · breadcrumb (org + `Pro` pill + trail) · docs / GitHub / Discord icons · `Get Started` (green) · theme toggle. Breadcrumb leaves are inconsistent (`Dashboard` shown for Global Policy, Global Connections, and App Availability; `Sso` / `Org api keys` mis-cased).

## Recurring design patterns

**Page header.** Uniform on every page: `<h1>` ~28px bold near-black, immediately followed by a single-sentence gray subtitle. Primary action, when present, is a **solid black button top-right, vertically aligned to the title**, with a leading `+` for create actions (`+ New project`, `+ Add Secret`, `+ Add LLM Key`, `+ New group`, `+ New mapping`, `+ Add Rule`). Subtitles consistently use an em-dash for the second clause and end in a period.

**Buttons.** Three tiers: **solid black** = primary; **outline/light** = secondary (`Manage Subscription`, `Generate token`, `Upgrade →`, `Copy`); **ghost gray** = tertiary/disabled (`Cancel`, disabled `Save`, disabled `Apply Changes`). Disabled state is a muted gray fill with gray text. Green is reserved for brand/status only (the `Get Started` CTA, `Current` badge, active nav, success states) — never for ordinary primary actions. One **split button** exists (Members `Invite` + caret). Plan-gated buttons carry a **leading lock icon**.

**Cards.** White, ~10px radius, 1px light gray border, no shadow. Section title bold ~15–16px, gray description beneath, then content. Related settings are stacked as separate sibling cards with generous vertical gaps (SSO page = 3 cards).

**Tables.** Borderless card-wrapped tables. Column headers are **uppercase, ~11px, letter-spaced, gray**. Rows ~46px, separated by hairlines, no zebra striping. Row actions live in a trailing unlabeled column as `⋮` or `×`. Tables can carry a **footer summary row** (`3 members`) and a **pinned non-deletable row** below the body (Global Policy's `DEFAULT / Default Rule`).

**Empty states.** Two variants, both centered, both with an icon + bold one-line title + a gray one-sentence explainer that tells you what the next action gets you:

- _Inside a solid card_ (Global Connections Custom/LLMs): larger, ~230px tall, icon sits in a **circular light-gray badge**.
- _Inside a dashed-border rectangle_ (Groups, Domains, SCIM tokens): shorter, ~110–140px; icon may be a plain glyph or a circular badge.
  Copy pattern is rigid: title = `No <things> yet`, body = `<Verb> a <thing> to <outcome>.`

**Tabs.** Underline style: active = bold near-black text with a 2px dark underline; inactive = gray. Tab bar spans the full content width with a 1px bottom border, and can host a **right-aligned item** (`Connected`) acting as a filter. Distinct from the **chip/pill filters** (Apps categories) where the selected chip is a solid black pill.

**Sub-nav pills.** The settings sub-nav (and sidebar) use a **pale green pill with green icon + green text** for the active item — the only place green is used structurally.

**Badges/chips.** `Pro` (pale green/green, breadcrumb) · `Current` (solid green, Billing) · `Included` (pale green/green, Billing features) · `YOU` (light gray/gray, Members) · `INVITED` (pale amber/amber, Members) · `DEFAULT` (plain uppercase gray text, Policy). Status semantics: green = active/good, amber = pending or at-limit, red = blocked.

**Code/monospace treatment.** Inline code chips with light gray fill for header names and token prefixes (`X-Project-Id`, `Authorization: Bearer oc_org_...`); read-only URL/ID fields render on a light gray fill with a trailing copy icon (`SCIM base URL`, `Organization ID`, the API key field).

**Progress / metering.** Three visual encodings: linear bar (sidebar agent quota, orange when full), circular ring gauge (Usage quota grid — `∞` glyph for unlimited, amber ring for at-limit), horizontal proportional bars in green (Usage by agent).

**Density & spacing.** Airy and roomy: content is constrained to a ~900px centered column on a wide viewport (so a lot of whitespace at 1568px), ~20–24px gaps between blocks, ~40px between page header and first content block. Most org pages are near-empty in these captures, which the design handles by centering a single card rather than stretching content.

**Copy voice.** Second person, plain, one sentence per idea, em-dashes for the qualifying clause, always states the _consequence_ ("the strictest matching rule decides each request", "the highest-priority mapping wins, owners are never changed", "the foundation for single sign-on"). Titles are sentence case; button labels are inconsistent between Title Case (`Add Rule`, `Add Secret`, `Add LLM Key`, `Manage Subscription`, `Switch Plan`, `Upgrade to Team`) and sentence case (`New project`, `New group`, `New mapping`, `Add domain`, `Create connection`, `Generate token`).
