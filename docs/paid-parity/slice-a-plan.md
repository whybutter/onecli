# Slice A — Nav shell split: approved implementation plan

**Status:** vetted and approved by the orchestrator. Implement exactly this.

**Product decisions already locked (do not revisit):** no plan tiers → no plan badge, no lock icons, no gated affordances anywhere. Billing and App Availability are dropped. Both switchers (org + project) stay in BOTH shells — this is a deliberate divergence from the competitor; comment it so it doesn't read as an oversight.

---

## Files owned exclusively by this slice

- `apps/web/src/lib/nav-config.ts`
- `apps/web/src/app/(dashboard)/_components/dashboard-sidebar.tsx`
- `apps/web/src/app/(dashboard)/_components/dashboard-header.tsx`
- `apps/web/src/app/(dashboard)/_components/nav-main.tsx`
- `apps/web/src/app/(dashboard)/layout.tsx` — **owned but deliberately NOT edited**
- New placeholder route directories (step 5)
- `apps/web/src/lib/nav-config.test.ts` — approved, in scope

Read-only reference: `apps/web/src/lib/navigation.ts` (`ORG_PATH_RE`, `PROJECT_PATH_RE`, `connectionsPath`). Do not modify.

Two sibling slices run in parallel on other files. Do not edit outside the list above.

---

## Scope detection

Add to `nav-config.ts`:

```ts
export type NavShell = "org" | "project";
export const resolveNavShell = (pathname: string): NavShell => …
```

Resolution order:

1. `ORG_PATH_RE.test(pathname)` → `"org"`; `PROJECT_PATH_RE.test(pathname)` → `"project"`. **Reuse the regexes already exported from `navigation.ts`** — do not write new ones. Test them unconditionally (no CAPS branch) so the function stays pure and unit-testable without `vi.stubEnv` + `vi.resetModules`.
2. Longest-prefix match of the bare path against `projectNavItems` then `orgNavItems`, with a **segment-boundary check** (`path === url || path.startsWith(url + "/")`). Longest URL wins — this is what splits `/settings/project` from `/settings/organization`.
3. Default `"org"`.

### ⚠️ Do NOT reuse `hasProjectContext()`

`hasProjectContext()` in `navigation.ts` looks like the answer and is not. In flat editions it returns `true` for every path, including `/team` and `/groups`, which would put every org page in the project shell. It answers "does the gateway resolve a project for this request", not "which shell is this page in". Leave it alone — it is load-bearing for the approvals bell.

### Edge cases (cover all of these in tests)

| Path                                                           | Shell         | Why                                                |
| -------------------------------------------------------------- | ------------- | -------------------------------------------------- |
| `/agents/<uuid>`                                               | project       | prefix `/agents`                                   |
| `/connections/apps/<provider>`                                 | project       | prefix `/connections`                              |
| `/global-connections`                                          | org           | distinct segment; no collision with `/connections` |
| `/settings/project`                                            | project       | longest match                                      |
| `/settings/organization`                                       | org           | longest match                                      |
| `/settings/{profile,api-keys,instance,encryption,domains,sso}` | org (default) | belong to neither shell                            |
| `/account/*` (EE)                                              | org (default) |                                                    |
| 404 / unknown                                                  | org (default) |                                                    |

---

## Step 1 — `nav-config.ts`

Replace the single `navItems` export with two lists.

`orgNavItems: NavItem[][]` — nested so `NavMain`'s existing `SidebarSeparator` renders the group break with no new code:

```
group 0: Projects            → /projects
         Global Connections  → /global-connections   (NEW placeholder)
         Global Policy       → /policy               (relabel of "Policy")
group 1: Members             → /team                 (relabel of "Team", URL unchanged)
         Groups              → /groups
         Usage               → /usage                (NEW placeholder)
         Organization Settings → /settings/organization
```

`projectNavItems: NavItem[]` — flat, no group break:

```
Overview → /overview
Install → /install
Agents → /agents
Connections → /connections
Activity → /activity
Project Settings → /settings/project
```

`projectBackLink: NavItem` = `{ title: "All projects", url: "/projects", icon: ChevronLeft }`. Use the existing `NavItem` type — no new type.

**Preserve every existing "always visible, the page degrades on 403" comment**, attached to the item it justifies. Those comments are the written record of the no-role-based-hiding rule. Do not introduce role-based nav hiding.

**Icons:** reuse what's imported (`FolderKanban`, `Plug`, `ShieldCheck`, `Users`, `UsersRound`, `Settings`, `LayoutDashboard`, `Download`, `Bot`, `Activity`). New: `ChevronLeft` for the back link, `ChartNoAxesColumn` for Usage, `Cable` for Global Connections (`Plug` is taken by project Connections). _Orchestrator note: icon choices are unsourced from the spec — these are approved defaults, mention them in the PR body._

Also in this file:

- `navItemsForShell(shell)`.
- `navBreadcrumbLabel(path): string | undefined` — exact-URL → title map built from `orgNavItems.flat()`, `projectNavItems`, `getSettingsSections()`, plus a small overrides record. Overrides carry `/projects` → `"All projects"` (sidebar says "Projects", breadcrumb says "All projects"). **This is the `Api keys` casing fix** — `getSettingsSections()` already titles it `"API Keys"`, so the lookup fixes it from existing data rather than a new special case.
- `getSettingsSections()` gains **Domains** and **Single sign-on**, both appended to the existing **Security** section → `Domains, Single sign-on, Encryption`. `settings-nav.tsx` and `settings-mobile-nav.tsx` already render whatever this returns, so they pick the entries up with **no edit** — keep them outside the footprint.
- **`settingsSections[0].items[0]` must stay `Project`** — `settings/page.tsx` redirects `/settings` to it and is outside the footprint. Keeping the order keeps that redirect working with zero edits there.
- **Delete the `navItems` export** rather than leaving a compat alias, so any consumer not found fails at `pnpm check-types` instead of silently rendering the old flat nav. Its only two consumers are `dashboard-header.tsx` and `dashboard-sidebar.tsx`, both owned here.

## Step 2 — `nav-main.tsx`

1. `NavMainProps` gains **optional** `backLink?: NavItem`. When present, render above the groups as `SidebarMenu` → `SidebarMenuItem` → `SidebarMenuButton asChild` wrapping a `Link`, with `tooltip={backLink.title}` (required for the icon-collapsed rail), muted styling, and **never** `isActive`. Render inline — do not extract a new component file.

   The prop is optional specifically so EE overlay code that imports this shared module keeps compiling untouched. Do not make it required.

2. Harden `isActive` from bare `pathname.startsWith(url)` to the same segment-boundary check used by `resolveNavShell`, so `/policy` can't light up for `/policy-drafts`. Keeps both "is this path under that item" rules identical.

## Step 3 — `dashboard-sidebar.tsx`

Call `usePathname()` → `resolveNavShell` → render:

```
shell === "project"
  ? <NavMain items={projectNavItems} backLink={projectBackLink} />
  : <NavMain items={orgNavItems} />
```

`OrgSwitcher` and `ProjectSwitcher` stay where they are in **both** shells. Add a comment recording that keeping the project switcher is a deliberate product decision.

## Step 4 — `dashboard-header.tsx`

Breadcrumb → `Org › All projects › Project › Page` (org shell: `Org › Page`). **No plan badge.** `PlanGateProvider` / `getCurrentPlan()` stay untouched.

1. **Org crumb** — reuse `useCurrentOrganizationId()` + `useOrganizationsList()` from `@/hooks/use-organizations`, exactly as `org-switcher.tsx` does. Same react-query keys → no extra network request. Links to `/projects`. Render only once a name resolves, so the header doesn't flash a placeholder.
2. **Project crumbs**, project shell only: `All projects` → `/projects`, then project name from `useCurrentProjectId()` + `useProjectsList()` (`@/hooks/use-projects`), linking to `/overview`.
3. **Page crumb** — replace `navItems.find(...)` with a longest-prefix match over `navItemsForShell(resolveNavShell(pathname))`, **with a fallback to `{ title: "Settings", url: "/settings" }` for `/settings/*` paths owned by neither shell.** Without that fallback `/settings/profile` regresses from `Settings › Profile` to `Dashboard`.
4. **Sub-segment labels** — keep the existing opaque-id filter (`/^[a-z0-9-]{16,}$/i && /\d/`) verbatim; it does real work and its comment explains why. Change only the label: try `navBreadcrumbLabel(cumulativeHref)` first, fall back to existing `formatSegment`. This fixes `Api keys` → `API Keys` and pre-solves `Sso` → `Single sign-on`.
5. Right-hand cluster, `ApprovalsBell`, `GetStartedButton` — untouched.

## Step 5 — placeholder pages

Four server components following the `settings/encryption/page.tsx` shape: `export const metadata`, `PageHeader` with title + description, brief "not available yet" body. **No lock icons, no upgrade CTAs.**

- `(dashboard)/global-connections/page.tsx` — segment name is **not arbitrary**: `connectionsPath()` already documents `basePath = /org/<id>/global-connections`. Match it so one name works across editions.
- `(dashboard)/usage/page.tsx` — description avoids quota/limit framing. e.g. "Request volume and per-agent usage."
- `(dashboard)/settings/domains/page.tsx`
- `(dashboard)/settings/sso/page.tsx`

**No `next.config.js` edit** — verify but do not change. `getOssDashboardSegments()` reads `(dashboard)` from the filesystem at build time and shadows bare segments to `/_not-found` for cloud/onprem-full; both new top-level names match its `/^[a-z0-9][a-z0-9-]*$/` filter, and the settings pages are covered by the existing `/settings/:path*` shadow.

## Step 6 — `layout.tsx`: no change

Owned but deliberately not edited. Sidebar and header derive the shell from the same pure function and the same `usePathname()`, so they agree by construction. A shell context provider would be new state that can only ever disagree with the pathname. The `isSettings` rail logic stays correct.

## Step 7 — tests

`apps/web/src/lib/nav-config.test.ts`, following `navigation.test.ts` as precedent. `resolveNavShell` is pure and CAPS-free, so plain `describe`/`it` covers every edge-case row plus `/global-connections` vs `/connections` non-collision and the `/settings/project` vs `/settings/organization` split.

---

## Orchestrator decisions on escalated questions

| Question                                                                         | Decision                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Should `/` redirect to `/projects` (org home) instead of `/overview`?            | **No change.** Keep `/` → `/overview`. `home-redirect.ts` is outside the footprint and is itself EE-aliased; changing it widens the slice into the overlay. Revisit as its own task if wanted. |
| Is `nav-config.test.ts` in scope?                                                | **Yes, approved.**                                                                                                                                                                             |
| Domains/SSO settings section placement                                           | **Security section approved.**                                                                                                                                                                 |
| `Team` → `Members` label with URL still `/team`                                  | **Approved.** Renaming the route breaks bookmarks and forces a re-shadow in `getOssDashboardSegments()`. If wanted, it's its own slice.                                                        |
| `/settings/*` shell flip (Project Settings → project shell, Profile → org shell) | **Deferred, accepted.** Deterministic, not broken. A sticky-shell cookie costs hydration risk for a narrow case. Revisit only if it reads badly in review.                                     |

---

## Known risks carried into implementation

1. **EE overlay divergence — highest.** `nav-config.ts`, `dashboard-sidebar.tsx`, `dashboard-header.tsx` are aliased to `@/ee/*` for `cloud`/`onprem-full`, and `apps/web/src/ee/` does not exist in this repo. **The URL-scoped editions keep the old flat nav until someone mirrors this in the private overlay.** That work is real, outside this footprint, and needs an owner. Mitigation already baked in: `resolveNavShell` handles `/org/<id>` and `/p/<id>` correctly, so the mirror is a copy of the two lists with prefixed URLs, not a redesign.
2. **`nav-main.tsx` is shared** and may be imported by the overlay sidebar. The prop is optional and the `isActive` change is strictly narrowing, so it should be safe — but it is unverifiable from this repo. Build the cloud edition where the overlay exists before merge.
3. **Static route→shell map drifts** — a future page with no nav entry silently lands in the org shell. Mitigated by tests and a comment on `resolveNavShell`; not eliminated.
4. **Breadcrumb crumbs pop in** after hydration (org/project names come from react-query, never SSR). Small horizontal shift on first paint. Accepted.
5. **Only `oss` exercises this in CI.** `onprem-slim` inherits these files but its `webSurface` is `connect-only`, so `proxy.ts` redirects the dashboard to `/app-connect`. The unit tests on `resolveNavShell` are what cover the `/org` and `/p` branches.
