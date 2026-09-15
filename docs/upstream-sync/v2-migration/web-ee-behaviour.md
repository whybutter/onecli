# `apps/web/src/ee/**` behavioural spec (upstream OneCLI v2.6.0)

Source of truth: `/Users/marco/Projects/ai-agents/onecli/.claude/worktrees/upstream-ref` (read-only). Every file path below is relative to `apps/web/src/` unless it starts with `packages/`.

This is a clean-room spec. It describes WHAT each enterprise UI surface does so a replacement `ee/` tree can be built without reading the original. Props interfaces are reproduced as TypeScript type text because they are the contract free code compiles against.

## 0. How to read this

**Fork profile assumed for the KEEP / TRIM / DROP verdicts:** small-team self-host with real RBAC (owner / admin / member), Google login only, no billing/Stripe, no SSO/SCIM, no Cognito, no cloud analytics. The fork DOES ship domain verification, directory groups, workspace sharing, and org settings.

**Two gating dials exist upstream; the fork needs at most one.**

1. **License dial (self-host):** `isEntitled()` from `packages/api/src/lib/entitlements.ts` — pure; `true` on cloud, on self-host `true` iff `ENTERPRISE_ENABLED` is `"true"`/`"1"` (read at call time). The browser cannot read it; it learns entitlement from `GET /v1/instance` → `InstanceInfo.entitled` via `useInstance()`. The client feature keys are `ENTERPRISE_FEATURES`:

   | key                 | label (used as title of locked card / dialog) |
   | ------------------- | --------------------------------------------- |
   | `sso`               | Single sign-on, verified domains & SCIM       |
   | `groups`            | Directory groups                              |
   | `granular_access`   | Resource-level access                         |
   | `workspace_sharing` | Workspace sharing                             |
   | `app_availability`  | App availability control                      |
   | `multi_org`         | Multiple organizations                        |
   | `rbac`              | Role-based access control                     |
   | `provisioning`      | Member provisioning                           |
   | `members_directory` | Members directory API                         |
   | `budget`            | Spend budgets                                 |
   | `ha`                | Multi-instance operation                      |

2. **Plan dial (cloud billing):** `PremiumFeature` = `"policy.manual_approval" | "policy.rate_limit" | "policy.deny_mode" | "sso" | "groups"` with required plans (team / pro / team / enterprise / enterprise). Driven by `usePlanUsage()`, which never fetches when `CAPS.billing` is false, so on self-host the plan lock is permanently disarmed. **The fork has no billing → the plan dial is dead; only the license dial matters, and the fork may hard-wire it to `entitled: true`.**

**Edition constants** (`lib/env.ts`): `EDITION_INFO = parseEdition(NEXT_PUBLIC_EDITION)`, `CAPS = capabilitiesFor(EDITION_INFO)` (fields used by web: `CAPS.billing`, `CAPS.rbac`), `IS_CLOUD`. Unset edition parses to onprem → `CAPS.billing=false`, `CAPS.rbac=false`, `IS_CLOUD=false`. Every `IS_CLOUD`/`CAPS.billing` branch in free code is therefore the non-cloud arm in the fork.

**Server-side role guard used by every admin page:** `requireOrgAdmin()` (`ee/auth/require-org-admin.ts`) — resolves `{userId, organizationId}` via `resolveOrgContext()`, calls `requireRole(userId, organizationId, "admin")`, and on ANY thrown error (forbidden or transient) calls `redirect(\`/org/${organizationId}/workspaces\`)`. It is defense in depth beside the `(admin)` route-group layout (`lib/dashboard/admin-layout.tsx`, which uses the free `userIsOrgAdmin`from`packages/api/src/services/workspace-access-check.ts` and redirects the same way).

**Route-wrapper pattern for licensed pages** (free code, `app/(dashboard)/org/[orgId]/(admin)/...`): the `page.tsx` calls `isEntitled()`; if false it renders `<EnterpriseLockedCard feature=… description=…/>` and never imports/executes the inner page; if true it renders the ee page. The ee page itself repeats `if (!isEntitled()) redirect(…/workspaces)` BEFORE any role read (defense in depth; pinned by tests).

**Shared UI primitives referenced below (all free):**

- `EnterpriseLockedCard({feature, description})` (`lib/components/enterprise-locked-card.tsx`): centered lock tile, `<h2>` = `ENTERPRISE_FEATURES[feature]`, a pill with the literal text `Enterprise`, `<p>` = `${description} Available with a OneCLI Enterprise license.`, button "Learn about OneCLI Enterprise" → `https://onecli.sh/pricing` (new tab). Server-component safe. Tests find it by `getByText("Enterprise")`.
- `LicenseRequiredDialog({open, onOpenChange, feature})` (`lib/components/license-required-dialog.tsx`): `UpgradeDialogShell` with lock icon, title `ENTERPRISE_FEATURES[feature]`, pill "Enterprise", description "This feature is part of OneCLI Enterprise and requires an Enterprise license.", footer button "Learn about OneCLI Enterprise" → pricing URL.
- `UpgradeDialogShell({open, onOpenChange, icon, title, pill?, description, children?, footer})`: a `sm:max-w-sm` dialog with centered icon tile, title, optional pill, description, optional body, footer.
- `PlanGateProvider` / `usePlanGate()` (`lib/plan-gate.tsx`): context `{ isLocked(feature: string): boolean; guard(feature: string): boolean }`. `isLocked(f)` = planLocked(f) || licenseLocked(f) where licenseLocked = `isEnterpriseFeature(f) && instance !== null && !instance.entitled`. `guard(f)` returns `true` and opens the matching dialog (paywall for plan lock, `LicenseRequiredDialog` for license lock) when locked, else `false`. Default context (no provider) is a no-op gate. Contract pinned by `lib/plan-gate.test.tsx`: `entitled:false` locks EXACTLY the `ENTERPRISE_FEATURES` keys (and `guard("groups")` opens the license dialog whose text content is the feature key); `instance === null` (loading) locks NOTHING and `guard` opens nothing; `entitled:true` locks nothing. Non-feature strings (e.g. `"agents"`) are never locked.
- `useInstance({poll?})` (`hooks/use-instance.ts`): React Query on `queryKeys.instance.all()` = `["instance"]`, `GET /v1/instance`, `staleTime: Infinity`, `gcTime: Infinity`, optional 30 s `refetchInterval`; returns `InstanceInfo | null` (null while loading).

**Query-key convention:** `queryKeys.<ns>.all()` = `[<ns>, orgIdOrDefault, workspaceIdOrDefault]` (scope derived from URL); `.list()` appends `"list"`. Exception: `instance` is unscoped.

**Toast library:** sonner (`toast.success` / `toast.error`). Mutation hooks generally toast the server's `err.message` on error and a fixed success string; components therefore don't re-toast errors.

---

## 1. Surfaces under `ee/`

### 1.1 Groups page — `ee/groups/**`

**Mounted at:** `app/(dashboard)/org/[orgId]/(admin)/groups/page.tsx:1-16` (wrapper: unlicensed → `EnterpriseLockedCard feature="groups" description="Organize members into directory groups, sync them from your IdP via SCIM, and map groups to org roles."`; licensed → `<GroupsPage/>`). Nav entry "Groups" at `${orgPrefix}/groups` (see §2.6 nav rules).

**Page (`ee/groups/groups-page.tsx`, async server component, default export, no props):**

1. `const { organizationId } = await resolveOrgContext()`.
2. `if (!isEntitled()) redirect(\`/org/${organizationId}/workspaces\`)` — before any role read.
3. `await requireOrgAdmin()`.
4. Renders `<PageHeader title="Groups" description="Organize members into groups, the building blocks for group-level access."/>`, then `<GroupList/>`, then `<RoleMappingList/>` in a `flex flex-1 flex-col gap-8` column.

**Tests (`groups-page.onprem.test.tsx`, `groups-page.cloud.test.tsx`) pin:** premise `CAPS.rbac === false` on onprem lane / `true` on cloud; licensed self-host admin AND owner render both child lists with `redirect` never called; member → throws `NEXT_REDIRECT:/org/org-1/workspaces` and `redirect` called with that path; UNLICENSED self-host (owner role) → redirect to workspaces with ZERO role checks performed; cloud with no `ENTERPRISE_ENABLED` still renders for admin (cloud is always entitled) and still redirects member. Children are mocked; `redirect` mock throws.

#### 1.1.1 `GroupList` (client, no props)

Data: `useGroups()` (drains all pages of `GET /v1/org/groups?limit=200&cursor=…` → `DirectoryPage<GroupRow>`; `retry:false`), `useCreateGroup()`, `useRenameGroup()`, `useDeleteGroup()`, `usePlanGate()`.

Layout: section header row — `<h2>` "Member groups", subtitle "Managed here or synced from your identity provider.", right-aligned `size="sm"` button "New group" (Plus icon). Below: a bordered rounded container holding one of:

- **Loading** (`isPending`): centered spinner.
- **Empty**: round muted icon (UsersRound), "No groups yet", "Create a group to organize members for group-level access."
- **Table** columns: `GROUP` (avatar circle hidden below md, name truncated, and if `group.source === "scim"` an outline badge `Lock` + "IdP" with `title="Managed by your identity provider. Membership and name sync from the IdP"`), `MEMBERS` (`memberCount`, tabular), actions column (right): ghost `xs` button — SCIM: `Eye` "View members"; manual: `UsersRound` "Manage members"; manual rows additionally get a kebab (`aria-label="Actions for ${name}"`) with items "Rename" and destructive "Delete". Rows have no hover wash (`hover:bg-transparent`).

Actions:

- "New group": `if (planGate.guard("groups")) return;` else open create `NameDialog` (title "New group", description "Groups collect members so access can be granted to a whole team at once.", submit "Create", pending "Creating..."). `onSubmit(name)` → `createGroup.mutateAsync(name)` → close.
- Rename → `NameDialog` (title "Rename group", description "Renaming does not change the group's members or anything granted to it.", submit "Rename", pending "Renaming...", prefilled). → `renameGroup.mutateAsync({groupId, name})`.
- Delete → `DeleteGroupDialog`; confirm → `deleteGroup.mutate(id, {onSuccess: close})`.
- Members → `GroupMembersDialog` mounted only while a target is set.

Hook side effects (free `hooks/use-groups.ts`): create → `POST /v1/org/groups {name}`, invalidate `queryKeys.groups.all()`, toast `Group "${name}" created`; rename → `PATCH /v1/org/groups/:id {name}`, invalidate, toast "Group renamed"; delete → `DELETE /v1/org/groups/:id`, invalidate, toast "Group deleted"; all errors toast `err.message`. Audit happens server-side in the API routes (withAudit); the web layer audits nothing here.

#### 1.1.2 `NameDialog`

```ts
interface NameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  pendingLabel: string;
  initialName?: string;
  pending: boolean;
  onSubmit: (name: string) => Promise<void>;
}
```

`sm:max-w-md` dialog; header title + xs muted description; form with `<Label for="group-name">Name</Label>`, input placeholder "e.g. Engineering", autofocus, `maxLength=100`. Valid iff `1 ≤ trimmed.length ≤ 100`. Reset to `initialName` each time it opens. Footer: ghost "Cancel", submit button `loading={pending}` `disabled={!valid || pending}` showing `pendingLabel` while pending. Submits the TRIMMED name.

#### 1.1.3 `DeleteGroupDialog`

```ts
interface DeleteGroupDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  groupName: string;
  pending: boolean;
  onConfirm: () => void;
}
```

AlertDialog: title `Delete “${groupName}”?`, description "Members keep their accounts. Only the group and anything granted through it goes away." Cancel (disabled while pending) / destructive action "Delete" → "Deleting..." (preventDefault, so the dialog stays open until the caller closes it).

#### 1.1.4 `GroupMembersDialog`

```ts
interface GroupMembersDialogProps {
  group: GroupRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}
```

`readOnly = group.source === "scim"`. Data: `useOrgMembersList(open)` (drains `GET /v1/org/members?limit=200&cursor=…`, `retry:false`) and `useGroupMembers(group.id, open)` (drains `GET /v1/org/groups/:id/members`). `useSetGroupMembers()` → `PUT /v1/org/groups/:id/members {userIds}` (replace-set), on success invalidates `groups.all()` and `groups.members(groupId)`; on error toasts `err.message`.

Layout (`sm:max-w-lg`, `p-0`): header "Members of {group.name}" + description (read-only: "This group is managed by your identity provider. Membership syncs from the IdP."; else "Pick which organization members belong to this group."). Body: loading spinner while either query pending; if no org members → icon + "No members found"; else: filter input (placeholder "Filter members...", `aria-label="Filter members by name or email"`, matches email or name case-insensitively); when editable a row `"{selected.size} of {orgMembers.length} selected"` (`aria-live="polite"`) with "Select all" / "Clear" text buttons (act on ALL members, not the filtered view); a native `max-h-[min(24rem,50vh)]` scroller listing every filtered member as a checkbox row (name or email bold, email below when name exists; checkbox disabled when read-only); empty filter → `No members match “{search}”`. Footer: ghost "Close" (read-only) or "Cancel"; when editable a "Save"/"Saving..." button `disabled={isPending || !dirty}`.

Edge cases pinned in code: the selection buffer is seeded ONCE per open, only after both queries settle (a `seededRef` guard), so background refetches never clobber in-progress edits; closing resets the seed guard and the search. `dirty` = set inequality versus the initially-loaded member set. On save success: close dialog, toast "Group members updated".

#### 1.1.5 `RoleMappingList` (client, no props)

Data: `useRoleMappings()` (`GET /v1/org/role-mappings` → `RoleMappingRow[]`, ordered highest priority first), `useGroups()`, create/update/delete/reorder mutations, `usePlanGate()`.

Layout: header `<h2>` "Role mappings", subtitle "Grant an org role to a group's members. The highest-priority mapping wins, owners are never changed.", right button "New mapping" (Plus). Container: loading spinner / empty (ShieldCheck icon, "No role mappings yet", "Map a group to a role to manage members' access from your directory.") / table with columns `ORDER` (two icon-xs ghost buttons `aria-label="Move up"` / `"Move down"`, disabled at the ends or while `reorder.isPending || isFetching`), `GROUP` (`groupName` + `"{memberCount} member(s)"`), `ROLE` (badge, `secondary` for admin else `outline`, capitalised), actions kebab (`aria-label="Actions for the ${groupName} mapping"`) with "Edit" and destructive "Remove".

Actions:

- "New mapping": `planGate.guard("groups")` first; then `RoleMappingDialog` in create mode with `availableGroups` = groups that don't already have a mapping. Submit → `createMapping.mutateAsync({groupId, role})`.
- Move: swaps ids at `index` and `index±dir` in the current order and calls `reorder.mutate(orderedIds)` → `PUT /v1/org/role-mappings/order {orderedIds}` (index 0 = highest). Blocked while a reorder is pending OR the list is refetching (stale order would swap wrongly).
- Edit: dialog mounted only while `editTarget` is set (so it never morphs into create mode during the close animation), `availableGroups=[]`, submit → `updateMapping.mutateAsync({id, input: {role}})` → `PATCH /v1/org/role-mappings/:id`.
- Remove: AlertDialog "Remove this role mapping?" / "{groupName} stops granting a role. Members also in another role-mapped group are re-resolved to that group's role; everyone else keeps their current role." Cancel / destructive "Remove" → "Removing...". → `DELETE /v1/org/role-mappings/:id`.

Hook effects (`hooks/use-role-mappings.ts`): every mutation invalidates `roleMappings.all()` AND `orgMembers.all()` (a mapping can change member roles); create toasts "Role mapping created", update "Role mapping updated", delete "Role mapping removed", reorder has no toast; errors toast `err.message`.

#### 1.1.6 `RoleMappingDialog`

```ts
type Role = "admin" | "member";
interface RoleMappingDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mapping: RoleMappingRow | null; // null = create
  availableGroups: { id: string; name: string }[];
  pending: boolean;
  onSubmit: (input: { groupId: string; role: Role }) => Promise<void>;
}
```

Title "Edit role mapping" / "New role mapping"; description "Members of the group receive this org role. When someone is in several mapped groups the highest-priority mapping wins; owners are never changed." Fields: **Group** — edit mode shows the group name as static text; create mode a Select (`placeholder "Select a group"`; when `availableGroups` empty the popover shows muted "No groups available to map."). **Role** — Select with "Member" (default) / "Admin". Live preview: `useRoleMappingPreview({groupId, role})` (`POST /v1/org/role-mappings/preview` → `{affectedCount}`), enabled only while open and a group is chosen; renders "No members would change role." or `"{n} member(s) would change role when you save."` Footer: ghost Cancel, submit "Create" / "Save" (edit) / "Saving..." while pending, `disabled={!valid || pending}` where valid = a group is selected. Errors thrown by `onSubmit` are swallowed (the hook toasts) and the dialog stays open. State resets to the mapping's values each open.

**Gating summary:** owner/admin only (member redirected); unlicensed → locked card (wrapper) / redirect (page). Client-side `guard("groups")` on both "New" buttons opens the license dialog if `instance.entitled === false`.

**Fork relevance:** GroupList + NameDialog + DeleteGroupDialog + GroupMembersDialog — **KEEP** (fork ships groups; drop the SCIM/IdP badge branch and copy, or keep it dormant since `source` is always `"manual"`). RoleMappingList + RoleMappingDialog — **TRIM**: the feature works without an IdP (applied on save) and pairs naturally with real RBAC, but its copy is IdP-flavoured and its sync triggers (SCIM/SSO) don't exist; keep only if the fork wants "group → org role" automation, otherwise drop and also drop `roleManagedByIdp` in ManageAccessDialog.

---

### 1.2 App availability — `ee/app-availability/**`

**Mounted at:** `app/(dashboard)/org/[orgId]/(admin)/settings/app-availability/page.tsx:1-16` (wrapper feature `"app_availability"`, description "Restrict which apps each workspace may connect, based on who has access to it."). The old top-level `(admin)/app-availability/page.tsx` just redirects to the settings URL. Settings sub-nav item "App Availability" (LayoutGrid icon) is listed unconditionally (`lib/nav-config.ts:210-214`); `nav-config.test.ts` pins that it is a settings entry, NOT a top-level org entry, with URL `/org/org-1/settings/app-availability`.

**Page (`app-availability-page.tsx`):** identical guard sequence to Groups (resolveOrgContext → `isEntitled()` redirect → `requireOrgAdmin()`), then `<PageHeader title="App Availability" description="Choose which apps each workspace may connect, based on who has access to it."/>` + `<AppAvailabilityEditor/>`. Tests (`.onprem` / `.cloud`) pin the same four arms as Groups (admin/owner render; member redirect; unlicensed redirect with zero role checks; cloud always entitled).

**API client (`ee/app-availability/api.ts`):**

```ts
export type AppAvailabilityMode = "open" | "restricted";
export interface AvailabilityRule { id?: string; name?: string | null; userIds: string[]; groupIds: string[]; providers: string[]; }
export interface AppAvailabilityConfig { mode: AppAvailabilityMode; rules: AvailabilityRule[]; }
export const availabilityConfigKey = () => [...queryKeys.appAvailability.all(), "config"] as const;
getConfig(): GET /v1/org/app-availability → AppAvailabilityConfig
setConfig(input): PUT /v1/org/app-availability body=AppAvailabilityConfig → AppAvailabilityConfig (server echo)
```

The key deliberately spreads `queryKeys.appAvailability.all()` so shared invalidations also cover it. The free workspace-scoped read `GET /v1/apps/available` (`lib/api/app-availability.ts`) is the connect-picker filter and stays free.

**Hooks (`use-app-availability.ts`):** `useAppAvailability(enabled=true)` — query on `availabilityConfigKey()`, `retry:false`. `useSetAppAvailability()` — mutation; on success `setQueryData(availabilityConfigKey(), data)`, `invalidateQueries(queryKeys.appAvailability.all())`, toast "App availability updated."; on error toast `err.message` or "Failed to update app availability." No client gateway flush (the audited API route flushes org-wide server-side).

**`AppAvailabilityEditor` (client, no props):**

- `locked = planGate.isLocked("groups")` (note: gated on the `groups` key, not `app_availability`). Query is `enabled: !locked`.
- **Locked state:** a Card titled "App availability" / "Restrict which apps each workspace may connect based on who has access to it. This is an Enterprise feature." with a button "Upgrade to Enterprise" whose click calls `planGate.guard("groups")`.
- **Initial error** (`isError && !seeded`): red text "Failed to load app availability." (once seeded, a background refetch error is ignored so live edits aren't replaced).
- **Loading** (`!seeded`): a `h-40` pulsing placeholder box.
- **Loaded:** Card with title "Restrict app availability", description "When on, a workspace can only connect apps granted by a rule that names one of the people who have access to it. When off, every app is available to every workspace.", and a Switch in the card action slot (`aria-label="Restrict app availability"`, checked iff `mode === "restricted"`, disabled while saving). When restricted, the card content shows `<RuleList/>`. Below the card, right-aligned "Save changes" button `loading={isPending}` `disabled={!dirty || isPending}`.
- Draft model: `RuleDraft { key: string (client uuid); id?: string; name: string; userIds; groupIds; providers }`. Seeded ONCE from the first loaded config (`seededRef`), re-seeded manually from the server echo after a successful save (edit buffer survives a failed save). `dirty` = an order-independent signature (mode + each rule's trimmed name + sorted ids) differs from the baseline signature; rules with no people OR no apps are excluded from the signature (they are no-ops the API drops).
- Save sends EVERY draft (`{id, name: trimmed || null, userIds, groupIds, providers}`); the API drops no-op rules (which is how a rule edited down to empty gets deleted).

**`RuleList({rules, onChange, disabled?})`:** empty → muted "No rules yet. Add a rule, choose the people it applies to, and the apps they may connect."; else a `RuleCard` per rule; always an outline `sm` "Add rule" (Plus) button appending `{key: uuid, name:"", userIds:[], groupIds:[], providers:[]}`. Rules are unordered (a person's available apps = union of every rule naming them).

**`RuleCard({rule, onChange(patch), onRemove, disabled?})`:** bordered card; header row with a borderless "ghost title" input (placeholder "Rule name (optional)", `aria-label="Rule name"`) and an `X` button `aria-label="Remove rule"`. Body: label `PEOPLE` → `IdentityMultiSelect`; label `APPS` → `AppMultiSelect` with `label = rule.name.trim() || "this rule"` (used for the trigger's accessible name `Apps for ${label}`).

**`IdentityMultiSelect({userIds, groupIds, onChange(userIds, groupIds), disabled?})`:** data from `useGroups()` and `useOrgMembersList(true)`. Options = groups (label name, sub "N member(s)") + members filtered to `status !== "suspended"` and email not ending `@onecli.internal` (placeholder accounts) — mirrors the backend ownership check so naming a suspended member can't wedge the save. Renders selected items as removable secondary chips (group icon `Users`, user icon `UserRound`, `aria-label="Remove ${label}"`; unknown ids fall back to the raw id) followed by a dashed "Add people or groups" pill opening a `w-80` popover: search input (placeholder "Search…", `aria-label="Search people and groups"`, matches label or sub), then sections "USER GROUPS" then "USERS" as checkbox rows; no matches → "No users or groups found."

**`AppMultiSelect({value: string[], onChange, disabled?, label?})`:** catalog from `getApps()` (`@onecli/api/apps/registry`) sorted by name. Trigger: outline `sm` button showing "Select apps" or up to 3 stacked `AppIcon`s + "N app(s)", chevron. Popover `w-72`: search "Search apps…" (`aria-label="Search apps"`), scrollable checkbox list with icon + name; empty → "No apps found."

**Gating:** admin/owner; licensed. Client lock key `groups`.

**Fork relevance:** **KEEP** (optional) — it is an org-wide allowlist that depends only on members + groups, both of which the fork ships. If kept, drop the "Upgrade to Enterprise" locked card (or route it to the license dialog) and consider gating on `app_availability` rather than `groups`.

---

### 1.3 Organization settings → General — `ee/settings/org-general-page.tsx`, `_components/org-details-form.tsx`, `_components/delete-org-card.tsx`, `ee/settings/actions.ts`

**Mounted at:** `app/(dashboard)/org/[orgId]/(admin)/settings/general/page.tsx:1` (`export { default } from "@/ee/settings/org-general-page"` — NO entitlement wrapper; this page is free-tier). Settings sub-nav item "General" (Building2). The `(admin)` layout still restricts it to admin/owner.

**Server actions (`ee/settings/actions.ts`, all `"use server"`):**

- Private `requireUser()`: `getServerSession()` else throw "Not authenticated"; load user by `externalAuthId` (select id,email,name) else "User not found"; `enforceSsoSession(session, user)` → throw its `error` if denied. (Fork: drop the SSO enforcement line.)
- ```ts
  export interface OrgData { id: string; name: string; slug: string; role: string; subscriptionStatus: string;
    workspaces: { id: string; name: string | null; channelApps: { provider: string }[] }[]; }
  getOrganizationData(): Promise<OrgData | null>
  ```
  `requireUser()`, then `requireOrgAdminContext()` (throws for members), then loads the caller's membership with the org (id, name, slug, subscriptionStatus, workspaces with each agent's channel providers flattened into `channelApps`). Returns `null` if no membership or suspended.
- `updateOrganizationAction(organizationId, {name}) : ActionResult<{id,name,slug}>` — via `safeAction`; `requireUser()`; membership must exist, be non-suspended and `role === "owner"` else throw "Only the organization owner can update it"; `validateOrgName(name)` (from `@onecli/api/ee/services/organization-service`, throws on invalid) → `db.organization.update({name})`; `revalidatePath("/org/[orgId]", "layout")`. **No audit** in the web layer.
- `deleteOrganizationAction(organizationId) : ActionResult<{redirectTo}>` — `requireUser()`; logs "organization deletion requested"; `deleteOrganization(organizationId, user.id)` (service enforces owner); then finds the caller's oldest remaining active membership → sets the default-org cookie to it (else clears the cookie); `revalidatePath("/", "layout")`; `redirectTo` = `/org/{remainingOrgId}/workspaces` or `/create-org`. **No web-layer audit** (logger only).
- `createOrganizationAction(name) : ActionResult<{redirectTo}>` — `requireUser()`; `validateOrgName`; `createOrganization(user.id, user.email, trimmed)` → `{workspace, organization}`; stamps `user.onboardingCompletedAt = now`; sets default-org cookie; `redirectTo = /w/{workspace.id}/overview`.

**Page (`org-general-page.tsx`, async server component):** `org = await getOrganizationData()`; if null → `<PageHeader title="Organization" description="You are not part of any organization."/>` only. Else `isOwner = role==="owner"`, `isAdmin = admin || owner`. Renders `<PageHeader title="Organization" description={isAdmin ? "Rename or delete your organization." : "View your organization details."}/>`; section `<h2>` "Organization details" with `<OrgDetailsForm orgId orgName readOnly={!isAdmin}/>`; and ONLY for owners a section `<h2>` "Danger zone" with `<DeleteOrgCard orgId orgName role workspaces/>`.

Note the mismatch the fork should decide on: the page lets ADMINS edit the form (`readOnly={!isAdmin}`) but `updateOrganizationAction` rejects non-owners with "Only the organization owner can update it" (surfaces as an error toast). Pick one; the server is the truth.

**`OrgDetailsForm({orgId, orgName, readOnly?})` (client):** Card. Field "Organization name" (input, `readOnly` styling muted + not-allowed cursor when read-only). Field "Organization ID": read-only input + outline "Copy"/"Copied" button (clipboard, 2 s flip). Footer (hidden when read-only): outline "Cancel" (resets to `orgName`) and "Save"/"Saving..." — both `disabled={!isDirty || pending}` where `isDirty = name.trim() !== orgName`. Save → `updateOrganizationAction(orgId, {name: trimmed})`; failure → `toast.error(result.error)`; success → `toast.success("Organization updated")` (the input keeps the new value; no reset).

**`DeleteOrgCard({orgId, orgName, role, workspaces})` (client):** destructive-bordered card: `<h3>` "Delete organization", text "Permanently delete this organization and all of its workspaces. Make sure you have a backup if you want to keep your data.", right-aligned destructive button "Delete organization" `disabled={role !== "owner" || pending}`. Opens an AlertDialog "Delete organization": if there are workspaces, "Acknowledge each workspace that will be deleted:" followed by a checkbox list (name or "Untitled", plus "· uninstalls 1 chat app" / "· uninstalls N chat apps" when the workspace has channel apps); then "This action **cannot** be undone. This will permanently delete the **{orgName}** organization and remove all of its workspaces." + (if any chat apps) " Their chat apps are uninstalled from your chat workspace, and anyone talking to them there loses the agent."; then "Type `{orgId}` to confirm." with an input (placeholder "Enter the organization ID", autofocus). Confirm button "I understand, delete this organization" / "Deleting..." enabled only when every workspace is checked AND `confirmText.trim() === orgId` AND not pending. Success → `router.push(result.data.redirectTo)`; failure → error toast. Closing the dialog resets the confirm text and checks.

**Fork relevance:** **KEEP** (rename, ID copy, owner-only delete with per-workspace acknowledgement). TRIM: drop `subscriptionStatus` from `OrgData`, drop the `enforceSsoSession` line, drop chat-app copy if the fork has no channels, and reconcile admin-vs-owner rename.

---

### 1.4 Organization settings → Domains — `ee/settings/org-domains-page.tsx`, `_components/org-domains-card.tsx`, `domain-txt-record.tsx`, `copyable-value.tsx`, `plan-gated-submit-button.tsx`

**Mounted at:** `app/(dashboard)/org/[orgId]/(admin)/settings/domains/page.tsx:1-16` (wrapper feature `"sso"`, description "Prove ownership of your email domains to enable home-realm discovery and SSO enforcement."). Sub-nav "Domains" (Globe). `enterprise-wrappers.onprem.test.tsx` pins: unlicensed → text "Enterprise" present and inner page absent; licensed → inner renders and no "Enterprise" text. The inner page has NO self-gate (the wrapper is its only server gate) and NO role check of its own beyond the `(admin)` layout.

**Page (`org-domains-page.tsx`, sync server component):** `<PageHeader title="Domains" description="Claim your company's email domains and verify them via DNS. Verified domains are the foundation for single sign-on."/>` + `<OrgDomainsCard/>`.

**`OrgDomainsCard` (client, no props):** data `useDomains()` (`GET /v1/org/domains` → `OrgDomain[]`), `useCreateDomain()`, `useVerifyDomain()`, `useDeleteDomain()`, `usePlanGate()`; `locked = planGate.isLocked("sso")`.

Layout: Card → a form row: `<Label for="domain-input">Add a domain</Label>`, input placeholder "example.com" (`max-w-sm`), `PlanGatedSubmitButton locked pending complete={!!input.trim()} label="Add domain" pendingLabel="Adding..."`, helper "You'll prove ownership by publishing a DNS TXT record." Submit: `if (planGate.guard("sso")) return;` then if trimmed non-empty `createMutation.mutate(domain, {onSuccess: clear input})`.

Below: loading → "Loading domains..."; empty → dashed box with Globe icon, "No domains yet", "Claim your company domain to enable SSO."; else a divided list, one block per domain: name + badge (verified → emerald "Verified"; else secondary "Pending"); right side: for unverified an outline `sm` "Verify"/"Checking..." button (`loading` only for the domain being verified, `disabled` while any verify is pending), and always a ghost trash button `aria-label="Remove ${domain}"`. Unverified rows also render `<DomainTxtRecord domain/>`.

Remove confirmation AlertDialog: "Remove {domain}?" / "The domain loses its verification. Features that depend on it (like SSO sign-in routing) will stop working for this domain." Cancel / "Remove" → `deleteMutation.mutate(id)`.

Hook effects (`hooks/use-domains.ts`): create → `POST /v1/org/domains {domain}`, invalidate `domains.all()`, toast "Domain added. Publish the TXT record to verify it"; error toasts server reason (blocklist / already claimed / invalid). verify → `POST /v1/org/domains/:id/verify`, invalidate, toast "Domain verified"; error toasts server message (typically TXT not found yet). remove → `DELETE /v1/org/domains/:id`, invalidate, toast "Domain removed"; error toast "Failed to remove domain".

**`DomainTxtRecord({domain: OrgDomain})`:** muted box: "Add this TXT record at your DNS provider, then click Verify. Changes can take a few minutes to propagate." then a 2-column grid: Type → `TXT`; Host → `@ ({domain.domain})`; Value → `<CopyableValue value={"onecli-verification=" + verificationToken} copyLabel="Copy TXT record value"/>`.

**`CopyableValue({value, copyLabel})`:** truncating mono `<code>` (select-all) + a copy icon button (`aria-label={copyLabel}`) using `useCopyToClipboard()`; shows a brand check icon while `copied`. Each instance owns its state.

**`PlanGatedSubmitButton`**

```ts
export interface PlanGatedSubmitButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  "type" | "loading" | "disabled" | "children"
> {
  locked: boolean;
  pending: boolean;
  complete: boolean;
  pendingLabel: string;
  label: string;
}
```

A `type="submit"` button, `loading={pending}`, `disabled={pending || (!locked && !complete)}` — i.e. while LOCKED it stays clickable even with empty inputs so the click reaches the form's `onSubmit`, where `planGate.guard(...)` opens the paywall/license dialog. Shows a `Lock` icon when locked; text = `pendingLabel` while pending else `label`.

**Fork relevance:** **KEEP** (domain verification ships). TRIM the copy that references SSO ("foundation for single sign-on", "Claim your company domain to enable SSO.", the removal warning) and gate on a fork-chosen key (or no gate). `PlanGatedSubmitButton` collapses to a plain submit button if there's no gate.

---

### 1.5 Organization settings → Single sign-on — `ee/settings/org-sso-page.tsx` + `_components/org-sso-card.tsx`, `sso-setup-form.tsx`, `sso-connection-details.tsx`, `sso-it-panel.tsx`, `require-sso-card.tsx`, `scim-card.tsx`

**Mounted at:** `app/(dashboard)/org/[orgId]/(admin)/settings/sso/page.tsx:1-16` (wrapper feature `"sso"`, description "Connect your identity provider for SAML/OIDC sign-in, enforce it org-wide, and provision members via SCIM."). Sub-nav "Single sign-on" (Fingerprint). Inner page has no self-gate.

**Page:** `<PageHeader title="Single sign-on" description="Connect your identity provider so your team signs in with their company accounts."/>` then `<OrgSsoCard/>`, `<RequireSsoCard/>`, `<ScimCard/>`.

**`OrgSsoCard`:** `useSsoConnections()` (`GET /v1/org/sso/connections` → `OrgSsoConnection[]`); Card showing "Loading SSO configuration..." / `<SsoConnectionDetails connection={connections[0]}/>` if any / else `<SsoSetupForm/>`. Single-connection model (only `[0]` is used).

**`SsoSetupForm`:** `locked = isLocked("sso")`. Two selectable type tiles: "SAML 2.0" — "Entra ID, Okta, and most enterprise IdPs." / "OpenID Connect" — "IdPs exposing an OIDC issuer with client credentials." Field "Connection name" (placeholder "Acme Okta"). SAML: label "IdP metadata" with a toggle link "Paste XML instead" ↔ "Use a metadata URL instead"; URL input (placeholder `https://login.microsoftonline.com/.../federationmetadata.xml`) or a 6-row mono Textarea (placeholder `<EntityDescriptor ...>`); helper "From your IdP's SAML app: federation metadata URL or the downloaded metadata XML." OIDC: "Issuer URL" (placeholder `https://login.example.com`), "Client ID", "Client secret" (password) + helper "Stored encrypted; never shown again." `complete` = name AND (SAML: chosen source non-empty | OIDC: issuer+clientId+clientSecret). Submit `PlanGatedSubmitButton label="Create connection" pendingLabel="Connecting..."`; handler guards `"sso"` then `createMutation.mutate({type, displayName, metadataUrl|metadataXml | issuer, clientId, clientSecret})` → `POST /v1/org/sso/connections`; toast "SSO connection created"; error toasts server reason.

**`SsoConnectionDetails({connection})`:** header: displayName, status badge (`active` emerald "Active", `disabled` outline "Disabled", else secondary "Pending"), uppercase type badge. Buttons: "Test"/"Testing..." (hidden when disabled) → `POST /v1/org/sso/connections/:id/test` → renders `checks[]` rows (green check / red X, name, optional detail); "Enable"/"Enabling..." (when disabled → `PATCH {enabled:true}`) or "Disable" (confirm dialog "Disable {name}?" / "SSO sign-in through this provider stops working until you enable it again. The configuration is kept." → `PATCH {enabled:false}`); ghost trash `aria-label="Remove ${name}"` (confirm "Remove {name}?" / "The identity provider is removed from the login service and this configuration is deleted. Team members can no longer sign in through it." → `DELETE`). Meta line: "Provider ID `{cognitoProviderName}`" + optional " · signing certificate expires YYYY-MM-DD" from `config.certExpiresAt`. Then `<SsoItPanel/>`. OIDC + not disabled: outline "Rotate client secret" → AlertDialog with a password input "New client secret", description "Paste the new client secret from your identity provider. The old secret stops working as soon as your IdP invalidates it.", action "Rotate" disabled until non-empty → `PATCH {clientSecret}`. Update/delete toasts: "SSO connection updated" / "SSO connection removed".

**`SsoItPanel({connection})`:** muted box "Give these values to whoever manages your identity provider" + (SAML: ". The email claim is required. Sign-in fails without it." else "."). Rows via `CopyableValue`: SAML → "ACS URL (reply URL)" `https://${COGNITO_DOMAIN}/saml2/idpresponse`, "SP Entity ID (audience)" `urn:amazon:cognito:sp:${COGNITO_USER_POOL_ID}`, "Email claim \*" (`SAML_EMAIL_CLAIM`), "Name claim" (`SAML_NAME_CLAIM`); OIDC → "Redirect URI" `https://${COGNITO_DOMAIN}/oauth2/idpresponse`, "Scopes" `openid email profile`, "Client authentication" `client_secret_post`. Entirely Cognito-shaped.

**`RequireSsoCard`:** `useSsoEnforcement()` (`GET /v1/org/sso/enforcement` → `{ssoRequired, hasActiveConnection, hasVerifiedDomain, canRequire, exemptMemberCount}`), `useUpdateSsoEnforcement()` (`PATCH {ssoRequired}`; success toast "Single sign-on is now required for this organization" / "Single sign-on is no longer required"; error toasts server reason). Card: label (Lock icon when locked) "Require single sign-on", text "Everyone with an email on your verified domain must sign in through your identity provider. Members marked as break-glass exempt keep their other sign-in methods."; when not enforced, not locked and a precondition is missing: "To turn this on: Verify your company domain first." or "…Complete a first sign-in through your IdP so the connection becomes active." Switch (`aria-label="Require single sign-on"`) `disabled = busy || (!locked && !enforced && !canRequire)` — stays interactive when LOCKED so the click can open the paywall. Turning ON: `guard("sso")` then a confirm AlertDialog "Require single sign-on?" with: "From the next sign-in on, every member with an email on your verified domain must log in through your identity provider. Email codes and Google sign-in will be rejected for them."; if `exemptMemberCount === 0` a red warning "No member is break-glass exempt yet. Exempt at least one owner on the Team page first. Otherwise an identity provider outage can lock out the entire organization, including you." else "{n} break-glass member(s) keep(s) their other sign-in methods."; then "If your own login isn't through SSO, exempt yourself first or your next sign-in will be blocked." Action "Require SSO"/"Enabling...". Turning OFF is never gated (a downgraded org must always be able to disable) and mutates immediately.

**`ScimCard`:** `useScimTokens()` (`GET /v1/org/scim/tokens` → `ScimToken[]`), `useGroups()` (to count `source==="scim"` groups), create (`POST {label}` → `CreatedScimToken` incl. one-time `token`; no success toast — the show-once dialog is the confirmation), revoke (`DELETE /:id`; toast "Token revoked. Provisioning requests with it stop immediately"; error "Failed to revoke token"). Layout: label (Lock when locked) "SCIM provisioning", text "Let your identity provider create, update, and deactivate members automatically. Paste the base URL and a token into your IdP's provisioning settings.", outline `sm` "Generate token" (guards `"sso"` first). "SCIM base URL" read-only mono box = `${API_ORIGIN}/scim/v2` with copy button (`aria-label="Copy SCIM base URL"`). Tokens: "Loading tokens..." / empty dashed box (KeyRound, "No provisioning tokens yet", "Generate a token to connect your IdP.") / rows: label, "Added {localeDate} · Last used {relative}" or "Never used", trash `aria-label="Revoke token ${label}"`. Footer note when SCIM groups exist: "{n} group(s) synced from your IdP · Last change {relative(latest lastUsedAt)}". Generate dialog: "Generate SCIM token" / "Name it after the IdP it's for, so you can tell tokens apart when rotating them."; "Label" input (placeholder "e.g. Okta", `maxLength 64`, Enter submits), Cancel / "Generate"/"Generating..." (disabled when empty); on success the SAME dialog swaps to a success view: check icon, "Token created", "Paste it into your IdP now. You won't be able to see it again.", mono token box with copy (`aria-label="Copy SCIM token"`), full-width "Done". Closing resets label + token. Revoke AlertDialog: `Revoke "{label}"?` / "Your identity provider loses access immediately, and provisioning stops until you generate a new token and paste it into the IdP. Members and groups it already synced are unaffected." Cancel / "Revoke token"/"Revoking...".

**Fork relevance:** **DROP** the whole page and all six components (no SSO/SCIM; the IT panel is Cognito-specific). Also drop the "Single sign-on" settings nav entry.

---

### 1.6 Workspace access — `ee/workspaces/_components/workspace-access-card.tsx`, `workspace-access-dialog.tsx` (+ `workspace-access-card.test.tsx`)

**Mounted at:** `WorkspaceAccessCard` — `lib/workspaces/settings-page.tsx:81` (`<WorkspaceAccessCard workspaceId={workspace.id} plan={plan}/>` where `plan` comes from `getWorkspaceQuota(orgId).plan`; on non-billing editions the quota service reports the TOP plan, so `isTeam` is true). `WorkspaceAccessDialog` — `lib/workspaces/_components/workspace-card.tsx:232` (share menu on the workspaces list).

**`WorkspaceAccessCard`**

```ts
interface WorkspaceAccessCardProps {
  workspaceId: string;
  plan: Plan;
}
```

`isTeam = isPlanAtLeast(plan,"team")`; `sharingLocked = planGate.isLocked("workspace_sharing")`; `useWorkspaceAccess(workspaceId, isTeam && !sharingLocked)` (the fetch is SUPPRESSED when locked — it would 403). Card "Workspace access": description "Share this workspace with teammates and groups. Members can use it; owners and org admins can also manage it." (when team or locked) else "Upgrade to the Team plan to share this workspace with your teammates." Row: **license branch outranks plan branch** — locked → text "Requires a OneCLI Enterprise license" + outline "Manage access" whose click is `planGate.guard("workspace_sharing")`; else team → summary ("Not shared yet" | "{n} person/people" · "{m} group(s)", counting users with `!isOwner` plus groups; skeleton while pending; "Couldn't load sharing" on error) + outline "Manage access" opening the dialog; else (free plan, cloud only) "Upgrade to Team"/"Redirecting..." via `useGuardedUpgrade(plan).startUpgrade("team")`. Dialog mounted only when `isTeam && !sharingLocked`. Also renders `<PlanSwitchDialog/>` sibling (billing).

Test (`workspace-access-card.test.tsx`, real `PlanGateProvider`, `usePlanUsage` → null, `useInstance` mocked): unlicensed (`entitled:false`) → `useWorkspaceAccess` called with `("ws-1", false)`, text "Requires a OneCLI Enterprise license" present, clicking "Manage access" opens the license dialog with content `workspace_sharing` and never the access dialog; same with `plan="free"` and never "Upgrade to Team"; licensed → called with `("ws-1", true)` and "Manage access" opens the access dialog, no license dialog.

**`WorkspaceAccessDialog`**

```ts
interface WorkspaceAccessDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}
```

Data: `useWorkspaceAccess(workspaceId, open)` → `GET /v1/workspaces/:id/access` → `{users: {id,userId,name,email,role:"owner"|"member",isOwner,createdAt}[], groups: {id,groupId,name,memberCount,createdAt}[]}`; `useOrgMembersList(open)`; `useGroups(open && !groupsLocked)` where `groupsLocked = isLocked("groups")`; `useSetWorkspaceAccess()` → `PUT /v1/workspaces/:id/access {users:[{userId, role}], groupIds}` → `{added, removed, roleChanged}`, on success invalidates `workspaceAccess.list(workspaceId)`; error toasts `err.message` or "Failed to update workspace access".

Layout (`sm:max-w-lg p-0`): title "Manage workspace access", description "Choose who can access this workspace. Members can use it; owners (and org admins) can also rename, share, or delete it." Body: initial loading (access OR members pending) → spinner; access error → "Couldn't load access" / "Something went wrong. Close and reopen to try again." (editable body is NEVER rendered on a failed load — a blind Save would silently remove shares). Else two sections:

- **People**: header "People" + "{selected} of {candidates} selected" (`aria-live`). Candidates = org members whose email doesn't end `@onecli.internal` (the creator is a normal, removable row). Empty → "No one to add" / "Invite teammates to your organization first." Else filter input (placeholder "Filter people...", `aria-label="Filter people by name or email"`) and a `max-h-[min(15rem,28vh)]` list; each row: checkbox, name/email, a secondary badge "Creator" for the row whose userId matches the `isOwner` user, and — only when selected — a borderless Select (`aria-label="Role for ${name}"`) with "Member" / "Owner". No filter match → `No people match “{search}”`.
- **Groups**: header "Groups" (+ Lock icon when locked). Locked → a full-width bordered button "Sharing with directory groups is an Enterprise feature. Upgrade to enable it." whose click is `guard("groups")`; pending → spinner; none → "No groups yet. Create groups in your organization's SSO settings."; else a `max-h-[min(11rem,22vh)]` checkbox list (name + "N member(s)").
  Warnings (amber, shown only after seeding, not loading, not error): no users and no groups selected → "No one will be able to use this workspace. Only org admins will reach it."; bindings exist but no selected user has role owner (groups carry no management role) → "No workspace owner set. Only org admins will be able to manage this workspace." Both are soft — Save is never blocked by them.
  Footer: ghost "Cancel" (disabled while saving), "Save"/"Saving..." `disabled={initialLoading || accessError || !dirty}`.
  Edit model: seeded once per open after access loads (`seededRef`), with a FROZEN baseline `{users:Set, groups:Set, roles:Map}` so a background refetch cannot shift the dirty baseline. Toggling a user on grants role "member" by default; toggling off deletes its role entry. `dirty` = users set differs OR groups set differs OR any kept user's role changed. Save success → close + toast "Workspace access updated".

**Fork relevance:** **KEEP** both (workspace sharing ships). TRIM: delete the plan branch (`isTeam`, `useGuardedUpgrade`, `PlanSwitchDialog`, "Upgrade to Team"); keep the license branch only if the fork keeps an entitlement dial (else the card is always the "team" arm). Reword "Create groups in your organization's SSO settings." to point at the Groups page.

---

### 1.7 Team — `ee/team/actions.ts`, `_components/manage-access-dialog.tsx`, `_components/team-upgrade-banner.tsx`, `claim-page.tsx`, `_components/claim-form.tsx`, `claim-hero.tsx`, `claim-sign-in.tsx`

#### 1.7.1 `ee/team/actions.ts` (`"use server"`)

- `getOrgSubscriptionStatus(): Promise<string>` — `requireOrgAdminContext()` then returns `organization.subscriptionStatus`. Used by `lib/team/team-page.tsx:18`.
- `getUserOrgRole(): Promise<OrgRole>` (`OrgRole = "owner"|"admin"|"member"`) — `resolveOrgContext()` → `getUserRole(userId, organizationId) ?? "member"`; ANY error → `"member"` (fail closed to the least privilege). Used by `lib/dashboard/dashboard-sidebar.tsx:57` and `ee/billing/_components/plan-badge.tsx:35`.
- `changeTeamMemberRole(targetUserId, newRole: "admin"|"member"): Promise<ActionResult>` — `safeAction`; `resolveOrgContext()`; `requireRole(userId, organizationId, "admin")`; `withAudit(() => changeMemberRole(organizationId, targetUserId, newRole), () => ({organizationId, userId, userEmail, action: "update", service: "team", metadata: {targetUserId, newRole}}))`; `revalidatePath("/", "layout")`. This is the ONLY web-layer audit in `ee/`.

**Fork:** `getUserOrgRole` + `changeTeamMemberRole` **KEEP** (re-home into `lib/team/actions.ts`); `getOrgSubscriptionStatus` **DROP**.

#### 1.7.2 `ManageAccessDialog` — mounted by `lib/team/_components/member-list.tsx:484-492` (only while `manageTarget` is set; opened from the "Manage access" kebab item that admins see for non-owner, non-self rows)

```ts
interface ManageAccessDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: string;
  email: string;
  currentRole: "admin" | "member";
  currentSsoExempt: boolean;
  roleManagedByIdp?: boolean;
}
```

Dialog "Manage access" / "Update access for {email}." Body: `RoleSelect` (free, `lib/team/_components/role-select.tsx`, `id="manage-role"`) — changing it first runs `planGate.guard("rbac")` (abort if locked), `disabled={roleManagedByIdp}` with helper "This member's role is managed by your identity provider. Change it through the group's role mapping." when locked by IdP. Then a row "SSO break-glass exemption" / "Can sign in without SSO when the organization requires it." with a Switch (`id="manage-sso-exempt"`) whose change first runs `guard("sso")`. Footer: ghost Cancel; "Save"/"Saving..." `disabled={!isDirty || busy}`. Save: if role dirty → `changeTeamMemberRole(userId, role)` (error → toast + stop); if exemption dirty → `useUpdateOrgMember().mutateAsync({userId, input: {ssoExempt}})` (`PATCH /v1/org/members/:userId`; hook toasts errors); then `toast.success("Access updated")`, close, `router.refresh()`.

**Fork:** **TRIM** to role-only (drop the SSO exemption row and, unless role mappings are kept, `roleManagedByIdp`). Keep the `rbac` guard only if an entitlement dial remains.

#### 1.7.3 `TeamUpgradeBanner` (no props) — mounted by `lib/team/team-page.tsx:37-39` when `isAdmin && members.length >= 2 && !isPlanAtLeast(plan,"team")`

Muted bordered row: "Your team is growing! Upgrade to the Team plan for advanced roles, 30-day audit logs, and unlimited workspaces." + `sm` button "Upgrade to Team"/"Redirecting..." via `useGuardedUpgrade().startUpgrade("team")`, plus a `PlanSwitchDialog` sibling. **Fork: DROP** (and drop the condition in team-page).

#### 1.7.4 Claim flow — mounted by `app/claim/page.tsx:1-24` (wrapper: unlicensed → `EnterpriseLockedCard feature="provisioning" description="Pre-provision member accounts and hand out claim links that bring teammates straight into your organization."`; licensed → `ClaimPage(props)` invoked as a function so tests can render both arms)

`ClaimPage({searchParams: Promise<{token?: string|string[]}>})` (async server): `session = getServerSession()`; token counts only if a single string; no token → `redirect(session ? "/" : "/auth/login")`; `provision = findPendingProvisionByToken(token)`; if found: signed out → `<ClaimSignIn callbackUrl={"/claim?token="+token}/>`, signed in → `<ClaimForm token orgName={provision.organizationName}/>`; not found → `redirect(session ? "/?error=claim_invalid" : "/auth/login?error=claim_invalid")`.
`ClaimHero({title, subtitle?, children?})`: centered card-less hero with brand backdrop, `BrandLogo`, serif `<h1>`, subtitle, children in a `max-w-sm` slot.
`ClaimSignIn({callbackUrl})`: hero "Claim your workspace" / "Sign in or create an account to get started." + full-width "Sign in" that stores `localStorage.claimCallbackUrl = callbackUrl` and pushes `/auth/login`.
`ClaimForm({token, orgName})`: hero title = orgName, subtitle "An account has been provisioned for you. Claim it to join the team."; buttons outline "Decline" (→ `/`) and "Claim account"/"Claiming..." → `useClaimProvision().mutate(token)` (`POST /v1/provisions/claim {token}` → `{organizationId, organizationName}`; error toasts) → toast `You have joined ${organizationName}` → `window.location.assign(/org/${organizationId}/workspaces)` (full navigation on purpose).
Test (`claim-page.onprem.test.tsx`): unlicensed → "Enterprise" text, ZERO calls to `findPendingProvisionByToken`, no sign-in screen; licensed + signed out → token resolved once and `ClaimSignIn` rendered, no "Enterprise".

**Fork: DROP** (provisioning/claim links are API-minted; the fork uses invitations + Google login). Keep the `/claim` route only as a redirect or remove it.

---

### 1.8 Account → Create organization — `ee/account/create-org-page.tsx`, `create-org-layout.tsx`, `_components/create-org-form.tsx`

**Mounted at:** `app/create-org/page.tsx:1` and `app/create-org/layout.tsx:1` (plain re-exports).

**Layout (client, `{children}`):** full-height column; header (max-w-5xl) with the OneCLI logo (light/dark variants), a theme toggle (`sr-only` "Toggle theme"), and an avatar dropdown (initials from name or email, name + email label, item "Account preferences" → `/account/preferences`, item "Sign out"/"Signing out..." calling `useAuth().signOut()`); children centered with `pt-[10vh]`.

**Page (async server):** no session → `redirect("/auth/login")`. If `!(await canCreateOrganization(session.id))`: unlicensed → `<EnterpriseLockedCard feature="multi_org" description="Run several organizations side by side and switch between them."/>` centered; licensed/cloud → `redirect(defaultOrgId ? /org/${id}/workspaces : "/")`. Otherwise `<CreateOrgForm/>`.

**`CreateOrgForm` (client, no props):** `max-w-lg` card: `<h1>` "Create a new organization", text "Organizations are a way to group your workspaces. Each organization can be configured with different team members and billing settings."; field "Name" (default `"{user.name}'s Org"` or `"{emailLocalPart}'s Org"`, placeholder "My Organization", autofocus) + helper "What is the name of your company or team? You can change this later."; right-aligned "Create organization"/"Creating..." `disabled={pending || !name.trim()}` → `createOrganizationAction(name)` → error toast or `router.push(redirectTo)`.

**Fork: TRIM** — keep only if multi-org is wanted (then drop "billing settings" from the copy and the `multi_org` lock); otherwise drop the route.

---

### 1.9 Auth — `ee/auth/*`

- `require-org-admin.ts` — described in §0. **KEEP** (re-provide under `lib/auth/`).
- `amplify-config.ts` — configures AWS Amplify Cognito (user pool, client, hosted-UI domain, scopes `openid email profile`, redirect to `window.location.origin`, code flow, email login). **DROP**.
- `cognito-provider.tsx` — `AuthProviderImpl({children})`: the cloud `AuthContext` value (Google via `signInWithRedirect({provider:"Google", prompt:"SELECT_ACCOUNT"})`, enterprise SSO via `signInWithRedirect({provider:{custom}})` with a retry after `UserAlreadyAuthenticatedException`, email-OTP sign-up/sign-in/confirm, federated-vs-native sign-out handling, OAuth-callback loading suppression on `/` with `?code&state`, `authError` from `signInWithRedirect_failure` unless the message matches `/cancell?ed/i`), wrapped in `AnalyticsProvider`. **DROP** (the free `lib/auth/auth-provider-onprem.tsx` already provides `isAuthenticated, isLoading, user, signIn, signOut, signInWithPassword, signUpWithPassword`).
- `cognito-server.ts` — `getServerSessionImpl(): Promise<AuthUser|null>` via Amplify server runner + `parseCognitoIdentityClaims`. **DROP** (free `lib/auth/auth-server-onprem.ts` is the other arm).
- `login-content.tsx` — `LoginContent` (no props): cloud login page: "Log in" / "Continue with your account to authenticate connections"; "Continue with Google"; optional email step (SSO home-realm lookup first, then OTP sign-up falling back to sign-in, 8-digit sign-in / 6-digit sign-up OTP, 60 s resend timer, "You're almost signed up", "Use a different method"); footer "Using single sign-on? Log in with SSO" → `/auth/login/sso`; privacy-policy line; post-auth sync to `/v1/auth/session` with `claimCallbackUrl` / `inviteCallbackUrl` / `postAuthCallbackUrl` precedence and 401 `sso_required` / 409 identity-conflict / 429 handling. **DROP** (free `login-content-onprem.tsx` is the self-host arm).
- `logout-cleanup.ts` — `clearClientAuthState()`: `posthog.reset()` (guarded) and expire every `onecli-*` cookie (`path=/`, `max-age=0`, `samesite=lax`); deliberately leaves Cognito cookies alone. **DROP** (or keep the cookie sweep in the onprem signOut if useful).
- `sso-login-content.tsx` — `SsoLoginContent`: "Single sign-on" / "Sign in with your organization's identity provider"; work-email input (`aria-label="Work email"`), "Continue with SSO"/"Redirecting to SSO..." (disabled until `isPlausibleEmail`); `lookupSsoProvider(email)` → redirect via `signInWithSso(provider)`; notices "Single sign-on isn't configured for this email domain." (lookup answered `sso:false`) or "Something went wrong. Try again, or use the regular login." (lookup failed); footer "Not using SSO? Log in another way" → `/auth/login`. Mounted by `app/auth/login/sso/page.tsx:1-13` (unlicensed → `redirect("/auth/login")`; test pins both arms). **DROP** page + component + route.
- `sso-lookup-client.ts` — `isPlausibleEmail(e) = e.includes("@") && e.includes(".")`; `lookupSsoProvider(email)` → `POST /v1/auth/sso/lookup {email}` → `{sso, provider?, enforced?}` or `null` on non-2xx/network (callers fail open). **DROP**.

---

### 1.10 Billing — `ee/billing/**`

All of this is cloud/Stripe UI; on self-host every piece is already dark because `CAPS.billing === false`. **Fork: DROP everything**, but free code imports several symbols, so the replacement must provide no-op stand-ins (see §2 and §3a). Behaviour, for completeness:

**Server actions**

- `actions.ts` — `getSubscriptionStatus(options?): Promise<SubscriptionState>` (`{status, hasStripeCustomer, cancelAtPeriodEnd, interval: "month"|"year"|null, renewsAt, salesManaged}`); reconciles the org's Stripe subscription (heals drifted customer ids, persists `subscriptionStatus`), `aws-marketplace` status is reported sales-managed.
- `api-request-actions.ts` — `getApiRequests()` (admin only; per-agent request/injection counts from Redis for the current billing period) and `getPlanUsage(): Promise<PlanUsage>` (member-readable; `UsageOverview & {organizationId, organizationName}` where `UsageOverview = {plan, resources: {name, current, limit}[]}`).
- `quota-actions.ts` — `getResourceQuota(resourceName): Promise<ResourceQuota>` = `{current, limit (Infinity when absent), plan, atLimit, organizationId}` derived from `getPlanUsage()`. Consumed by free create buttons and invite button.
- `aws-marketplace/actions.ts` — `hasPendingMarketplaceToken()` (false unless `IS_CLOUD`), `completeMarketplaceRegistration()` (refuses with "Not available on this deployment." unless cloud; admin/owner only; consumes the `aws-mp-token` httpOnly cookie). `token-cookie.ts` exports `AWS_MP_TOKEN_COOKIE = "aws-mp-token"`. Tests (`edition-gate.onprem.test.ts`) pin that on onprem the fulfill route is a plain 404 with no cookie, the register page `notFound()`s before touching session/cookies, `hasPendingMarketplaceToken` is false without reading cookies, and `completeMarketplaceRegistration` refuses before any registration.

**Hooks**

- `use-plan-usage.ts` — `usePlanUsage(): PlanUsage | null`: React Query key `["billing","planUsage", routeKey]`, `enabled: CAPS.billing` (so ALWAYS `null` on self-host); re-invalidates 3 s after `?checkout=success`. Exports `QUOTA_WARNING_THRESHOLD = 0.8` and `isFlaggedOverLimit(resource, plan)` (over limit, except paid plans over the grandfathered "Agents"/"Members" caps).
- `use-subscription-status.ts` — query `queryKeys.billing.subscriptionStatus()` → `getSubscriptionStatus()`, `staleTime 60 s`, returns null while loading.
- `use-checkout.ts` — `checkout(plan, interval="month")` → `POST /v1/billing/checkout {plan, interval, cancelUrl}`; `switched` → reload, else navigate to `checkout_url`; error toast; resets `loading` on bfcache `pageshow`.
- `use-guarded-upgrade.ts` — `useGuardedUpgrade(knownCurrentPlan?)` → `{startUpgrade(plan), checkoutLoading, switchTo, switchInterval, closeSwitchDialog}`: paid→paid opens `PlanSwitchDialog` (proration preview); free→paid goes straight to checkout.
- `use-plan-switch.ts` — `usePlanSwitchPreview(plan, interval)` (`POST /v1/billing/checkout/preview`, `staleTime 0`) and `useSwitchPlan()` (`POST /v1/billing/checkout {plan, interval, prorationDate}`; follows `checkout_url` if not `switched`, else reload).
- `format.ts` — `formatDollars(cents)`, `formatWholeDollars(cents)`, `pct(current,total)`.

**Pages/routes**

- `billing-route.tsx` (default export; mounted at `(admin)/billing/page.tsx`): `if (!CAPS.billing) redirect(…/workspaces)`; `requireOrgAdmin()`; `<BillingPage/>`.
- `page.tsx` (`BillingPage`, client): "Billing" / "Manage your subscription and billing."; spinner until `useSubscriptionStatus()`; then `<BillingContent status cancelAtPeriodEnd currentInterval salesManaged/>`.
- `billing-content.tsx` — `BillingContent({status, cancelAtPeriodEnd?, currentInterval?, salesManaged?})`: interval toggle, one card per `offeredPlans(currentPlan)` (price, "N agents included" + InfoTip, seats, features, per-card action: Current Plan / Activate Plan (reactivate → `POST /v1/billing/reactivate`) / Switch to Yearly|Monthly Billing / Manage Subscription (`POST /v1/billing/portal` → `portal_url`) / Included in your plan / Contact sales to change your plan / Upgrade|Switch Plan), an Enterprise card with "Contact Sales", and a `PlanSwitchDialog`.
- `api-requests-page.tsx` (default; mounted at `(admin)/usage/page.tsx`): `CAPS.billing` redirect; `requireOrgAdmin()`; loads `getApiRequests()`, `getPlanUsage()`, `getSubscriptionStatus()`; renders "Usage" / "Track your plan usage and API requests." + `CurrentPlanCard`, `PlanUsageContent`, `ApiRequestsContent`.

**Components (`_components/`)**

- `quota-limit-dialog.tsx` — `QuotaLimitDialog({open, onOpenChange, resourceName, current, limit, plan, organizationId})`: `UpgradeDialogShell` with amber Gauge, title `${resourceName} limit reached`, description `Your ${planName} plan includes ${limit} ${noun}. Upgrade your plan to create more.`, body `UsageBar`, footer Cancel + "Upgrade" link to `${orgPrefix}/billing`. **Imported by free code** (create-agent-button, create-secret-button, invite-button, create-workspace-button).
- `plan-paywall-dialog.tsx` — `PlanPaywallDialog({open, onOpenChange, feature: PremiumFeature|null, organizationId: string|null})`: per-feature icon/title/description (manual approval, rate limiting, deny by default, "Verified domains & SSO", "Groups"), pill = cheapest offered unlocking plan name, footer = Contact Sales (sales-managed tiers) / "Upgrade to {plan}" (single unlocking plan) / "Upgrade now" link to billing. Lazy-loaded by `lib/plan-gate.tsx` only when a PLAN lock fires (never on self-host).
- `sidebar-quota.tsx` — `SidebarQuota()` = `<AgentsQuotaWarning/>` + `<IntegrationCallsWarning/>` (each a link card to billing, rendered only near/over their caps). Rendered by the sidebar only when `CAPS.billing`.
- `over-quota-banner.tsx` — `OverQuotaBanner()`: null on `/billing` paths or when nothing is flagged; else an amber link banner "Over plan limits" / "Approaching plan limits" listing `current/limit name` on the plan. Rendered by `lib/dashboard/org-layout.tsx:40` (static import) and `lib/workspaces/workspace-layout.tsx:10-14` (dynamic import). Returns null whenever `usePlanUsage()` is null.
- `plan-badge.tsx` — `PlanBadge()`: skeleton until usage; admin over-limit → "Upgrade" link; admin → plan-name link to billing; member → static plan name. Uses `getUserOrgRole()`. Rendered by `lib/dashboard/dashboard-header.tsx:171` only when `CAPS.billing`.
- `upgrade-to-team-button.tsx` — `UpgradeToTeamButton({label="Upgrade to Team", size="sm", className?})` + `PlanSwitchDialog` sibling. Imported by `lib/workspaces/_components/workspace-card.tsx:45` (non-team share upsell) and the granular-access pickers.
- `agents-quota-warning.tsx`, `integration-calls-warning.tsx`, `usage-bar.tsx` (`UsageBar({label, current, limit})`), `info-tip.tsx` (`InfoTip({tipKey})` tooltips for agent/workspace/sharedWorkspaces), `current-plan-card.tsx` (`CurrentPlanCard({subscription})`), `plan-usage-content.tsx` (`PlanUsageContent({data: UsageOverview})` ring grid), `api-requests-content.tsx` (`ApiRequestsContent({data})` totals + per-agent table), `plan-switch-dialog.tsx` (`PlanSwitchDialog({plan: PlanConfig|null, initialInterval, onClose})` proration confirm), `billing-interval-toggle.tsx` (`BillingIntervalToggle({value, onChange, disabled?})` Monthly / Yearly "2 months free"), `security-trust-bar.tsx` (three static badges; unused).

**Fork: DROP** all; provide stand-ins per §2/§3a.

---

### 1.11 Budget — `ee/budget/**` (DORMANT upstream)

`budget-api.ts` — typed client for `/v1/partner/orgs/:orgId/budgets` (list), `POST|DELETE /v1/partner/orgs/:orgId/secrets/:secretId/budget`; the comment states the partner router was removed and nothing mounts these. `use-budget.ts` — `useOrgBudgets`, `useSetBudget`, `useClearBudget` on key `["budget","org",orgId]`. `budget-pricing.ts` — re-exports `METERED_SECRET_TYPES, isMeteredType, BUDGET_PERIODS, centsToUsd, nanosToUsd`. `_components/usage-meter.tsx` — `UsageMeter({spentCents, limitCents, period})`: "$spent / $limit", "this month"/"total", progress bar green→amber(≥80%)→red, "Key paused: limit reached" when over. Nothing in free code imports any of it. **Fork: DROP.**

---

### 1.12 Granular (resource-level) access — `ee/granular-access/**` and `ee/policy-editor/_components/resource-scope-fields.tsx`

**Free seam:** `lib/granular-access/index.ts` is literally `export * from "@/ee/granular-access"`; `lib/policy-editor/resource-scope.tsx` imports the TYPE `ResourceScopeFieldsProps` from the ee module and lazy-loads the ee component only when `IS_CLOUD`; otherwise (self-host) it renders — for supported providers and when not read-only — a dashed hint: "Resource scoping (limit this connection to specific repositories or folders) is available on OneCLI Cloud." (returns null for unsupported providers / read-only).

**`ee/granular-access/index.ts`:** re-exports the free types `GranularAccessConfig, GranularAccessItem, PolicyDialogContentProps` (`lib/granular-access/types.ts`) and exports `granularAccessConfigs: Map<string, GranularAccessConfig>` = `{"github-app": {...githubAppConfig (free, lib/granular-access/configs/github-app), PolicyDialogContent: lazy GithubAppPolicyDialogContent}, "dropbox": {...dropboxConfig, PolicyDialogContent: lazy DropboxPolicyDialogContent}}`. Pickers are `next/dynamic` so the map stays data-only in the shared chunk.

**`ResourceScopeFields`**

```ts
export interface ResourceScopeFieldsProps {
  connection: Connection; // from "@/lib/api"
  policy: Record<string, unknown> | null; // null = all
  onChange: (policy: Record<string, unknown> | null) => void;
  readOnly?: boolean;
  orgPolicy?: Record<string, unknown> | null; // the org boundary
}
```

Renders nothing unless `config = granularAccessConfigs.get(connection.provider)` exists, `config.isSupported(metadata)` and `config.PolicyDialogContent` exist. `licenseLocked = planGate.isLocked("granular_access")`. `effective = intersectPolicies(orgPolicy, policy)`; `selected = config.getSelectedItems(effective)`; `emptyScope = effective !== null && selected.length === 0`. Summary text: `No ${plural}` (empty scope) | `config.formatSummary(effective, meta)` | `${n} ${singular|plural}` | `All ${plural}`. UI: label "Resources"; a bordered row with the provider icon + summary and, when editable, an outline `sm` button "Manage" (`aria-label="Manage resources"`, Lock icon when license-locked) that runs `guard("granular_access")` then opens a dialog titled `connection.label ?? connection.id` / "Choose which {plural} this connection's credential can reach." hosting `<Content connectionId metadata policy={draft} orgBoundary={orgPolicy} onPolicyChange={setDraft} onSave onCancel/>`. Save normalises an empty selection to `null` (empty list is ambiguous at the gateway). Helper text: license-locked with a saved scope → amber `role="status"` "Saved resource limits are not enforced without an Enterprise license. This credential currently reaches all {plural}."; empty scope → destructive "Nothing selected here is allowed by your organization, so this connection can't reach anything. Pick from the {plural} your organization allows, or ask an administrator to widen them."; else "Limit which {plural} this connection's injected credential can reach" + (", within the {plural} your organization allows." when an org policy exists).

**`GithubAppPolicyDialogContent(props: PolicyDialogContentProps)`:** repos from `metadata.repos: string[]`. Segmented control "All repositories" / "Selected repositories" (all → `onPolicyChange(null)`, selected → `{repositories: []}`). Selected mode: search (only when > 8 repos, placeholder "Search repositories..."), checkbox list of `owner/name` split to the short name; a repo outside the org boundary (`!coveredBy(repo, orgBoundary)`) is disabled ONLY in the check direction (already-checked ones stay removable) with trailing text "Not allowed by your organization" / "No longer allowed by your organization. Remove it."; empty list → "This connection grants access to all repositories, so there are no individual repositories to narrow to." or `No repositories match “{q}”`; "N of M selected". Toggling the last repo off reverts to `null`. Footer: ghost Cancel + "Save" — replaced by `UpgradeToTeamButton` when `getCurrentPlan()` resolves to a plan below team (optimistic default = has team features; null plan keeps the optimistic default).

**`DropboxPolicyDialogContent`:** same segmented control ("All folders" / "Selected folders", policy `{folders: string[]}` of lower-cased paths); breadcrumb Home › segments; search "Search this folder..."; folder list via `useDropboxFolders(connectionId, currentPath, enabled)` (`queryKeys.dropbox.folders`, `GET` through `dropbox.folders()` → cloud-only `/v1/apps/dropbox/folders`), states: spinner / "Couldn't load folders. The connection may be missing the file metadata permission." / "No folders match "{q}"" / "No subfolders here"; a folder under a selected parent shows checked + "via parent" and is disabled; boundary rule as GitHub; drill-in button always enabled; selected chips with remove buttons (`aria-label="Remove ${path}"`); same team-plan footer rule.

**Fork relevance:** **TRIM.** The free `lib/granular-access/index.ts` MUST still export `granularAccessConfigs` (the policy editor and the connection rows consume it for summaries). Minimal replacement: build the map from the free configs with `PolicyDialogContent` omitted (then `ResourceScopeFields` renders nothing and the onprem hint stays). Optional: keep the GitHub picker (pure client, no plan check, Save always enabled) and drop Dropbox (its folder endpoint is cloud-only). `lib/policy-editor/resource-scope.tsx` also needs the `ResourceScopeFieldsProps` type from somewhere — move it into free code.

---

### 1.13 Request an app — `ee/apps/request-app-slot.tsx`, `request-app-dialog.tsx`, `request-app-action.ts`

Free dispatcher `lib/components/request-app-slot.tsx:27-32` renders the ee `RequestAppSlot` when `IS_CLOUD`, else the free `LocalRequestAppSlot` (GitHub issue link). Props (free-owned): `RequestAppSlotProps { requestOpen?, onRequestOpenChange?, initialName?, initialUrl? }`.
Cloud slot: dashed grid tile "Request an app" / "We'll add it for you" opening `RequestAppDialog` ("Request an app" / "Can't find the app you need? Tell us about it and we'll do our best to add it within a week."; fields "App name \*" (max 100, placeholder "e.g. Notion") and "Website URL (optional)" (max 500, placeholder "e.g. notion.so"); a debounced favicon preview via `/v1/favicon?domain=`; submit "Submit request"/"Submitting..."; success toast "Got it! We'll email you when it's live."). Server action `submitAppRequest(name, websiteUrl|null)` validates with zod (name 1–100 trimmed; URL max 500, `https://` prefixed), resolves org context, logs, then AFTER the response emails the user an acknowledgment from "Jonathan from OneCLI" (Resend) and `notifyDiscord("app_request", …)`.
**Fork: DROP** (the local arm already exists).

### 1.14 Reviewer login — `ee/review/reviewer-login-page.tsx` (mounted at `app/review/login/page.tsx`)

App-store-reviewer backdoor: email/password form restricted to `test@onecli.sh` ("This login is restricted to the test account."), Amplify password sign-in, `GET /v1/auth/session` sync, `POST /v1/reviewer/login-notify`, redirect to `/w/{workspaceId}/overview` or `/workspaces`. **Fork: DROP** page + route.

### 1.15 Analytics — `ee/analytics.tsx`, `analytics-pageview.tsx`, `fathom.tsx`

`AnalyticsProvider({children})`: if `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` are both set at build time, init PostHog (`capture_pageview:false, capture_pageleave:true, person_profiles:"identified_only"`), identify the auth user (id, email, name), track SPA pageviews, and mount Fathom if `NEXT_PUBLIC_FATHOM_SITE_ID`; otherwise render children untouched and never init. Test (`analytics.test.tsx`) pins: unset vars → children rendered, no PostHog provider, `posthog.init` never called, no Fathom script; set vars → init called with key/host and Fathom `data-site` present. Only consumed by the Cognito provider. **Fork: DROP.**

---

## 2. Free components that embed ee pieces — what a replacement must provide

For each: exact ee symbols imported → minimal self-host behaviour the free component needs.

### 2.1 `lib/team/team-page.tsx`

Imports: `getOrgSubscriptionStatus` from `@/ee/team/actions` (line 7), `TeamUpgradeBanner` from `@/ee/team/_components/team-upgrade-banner` (line 10), plus `getUserRole` from `@onecli/api/ee/services/authorization-service` and `normalizePlan, isPlanAtLeast` from `@onecli/api/ee/billing/plans`.
Behaviour: loads role, members (`getTeamMembers()` from free `lib/team/actions.ts`, admin-gated), subscription status, org name; renders "Members" header, `InviteButton` for admins, the upgrade banner when `isAdmin && members.length >= 2 && plan < team`, and `MemberList`.
Minimal replacement: delete the subscription/plan/banner lines; keep `getUserRole` (or an equivalent role read). Nothing else.

### 2.2 `lib/team/_components/member-list.tsx`

Imports: `ManageAccessDialog` (`@/ee/team/_components/manage-access-dialog`, line 56) and type `TeamMember` (`@onecli/api/ee/services/team-service`, line 57).
Uses: mounts the dialog with `{open, onOpenChange, userId, email, currentRole, currentSsoExempt: member.ssoExempt, roleManagedByIdp: member.roleManagedByIdp ?? false}` when an admin picks "Manage access" on a non-owner, non-self row. Everything else in the list (remove with workspace acknowledgement, suspend/reinstate via `PATCH /v1/org/members/:id {status}`, leave org, cancel invitation) is free.
Minimal replacement: a `ManageAccessDialog` with at least `{open, onOpenChange, userId, email, currentRole}` that changes the role through an audited server action and `router.refresh()`es. `TeamMember` needs `userId, email, name, role, status, ssoExempt?, roleManagedByIdp?, joinedAt`.

### 2.3 `lib/team/_components/invite-button.tsx`, `lib/agents/_components/create-agent-button.tsx`, `lib/connections/_components/create-secret-button.tsx`, `lib/workspaces/_components/create-workspace-button.tsx`

Imports: `getResourceQuota, type ResourceQuota` (`@/ee/billing/quota-actions`) and `QuotaLimitDialog` (`@/ee/billing/_components/quota-limit-dialog`). Create-workspace-button imports only the dialog and takes `quota: WorkspaceQuota` from `getWorkspaceQuotaAction()` (which wraps `getWorkspaceQuota` from `@onecli/api/ee/services/quota-service`).
Behaviour: on mount call `getResourceQuota("Members"|"Agents"|"Secrets")`; if `quota.atLimit` the click opens the quota dialog instead of the real action; invite-button fails open on error.
Minimal replacement: either delete the quota wiring, or provide `getResourceQuota()` that resolves `{current:0, limit:Infinity, plan:"enterprise", atLimit:false, organizationId}` and a `QuotaLimitDialog` that renders null. For workspaces, `atLimit` is `quota.memberCount <= 1 && limit !== Infinity && current >= limit`, so an unlimited `getWorkspaceQuota` also disarms it.

### 2.4 `lib/dashboard/dashboard-sidebar.tsx`

Imports: `getUserOrgRole` (`@/ee/team/actions`, line 17), `SidebarQuota` (`@/ee/billing/_components/sidebar-quota`, line 33), type `OrgRole` (`@onecli/api/ee/services/authorization-service`, line 32).
Behaviour: `role` state defaults to `"member"` and is set from `getUserOrgRole()` on mount (errors ignored); members see only org nav items whose URL ends in `/workspaces` (allowlist `MEMBER_ORG_NAV_PATHS`); `getNavItems(orgId, {entitled: instance && instance.entitled, hosted})`; `SidebarQuota` rendered in the footer only when `CAPS.billing`.
Minimal replacement: `getUserOrgRole(): Promise<"owner"|"admin"|"member">` that never throws (returns `"member"` on any failure); `SidebarQuota` can be removed together with the `CAPS.billing` block. Tests (`dashboard-sidebar.onprem.test.tsx`, `dashboard-sidebar.test.tsx`) mock `getUserOrgRole → "owner"` and `SidebarQuota → null`.

### 2.5 `lib/dashboard/dashboard-header.tsx`

Imports: `PlanBadge` (line 51), `usePlanUsage` (line 52). Uses `usePlanUsage()?.organizationName` for the org breadcrumb and renders `<PlanBadge/>` — both only inside `!isAccount && CAPS.billing`.
Minimal replacement: remove the block, or keep `usePlanUsage` returning `null` (the breadcrumb then shows skeletons forever — so remove it, or source the org name elsewhere).

### 2.6 `lib/dashboard/org-layout.tsx` and `lib/workspaces/workspace-layout.tsx`

Import `OverQuotaBanner` (static at org-layout:4; `next/dynamic` at workspace-layout:10-14). Rendered unconditionally above children.
Minimal replacement: a component returning `null`, or remove the two render sites.

### 2.7 `lib/nav-config.ts` (free, no ee import, but encodes entitlement rules)

- Admin group: "Members" (`/team`) always; "Groups" (`/groups`) when `CAPS.rbac || (entitled === true || entitled === false)` — i.e. hidden only while the runtime entitlement is UNKNOWN (null/undefined) on a non-RBAC build, shown once known EITHER way (an unlicensed deployment lands on the locked card); "Usage" + "Billing" only when `CAPS.billing`; "Organization Settings" (`/settings/general`) always.
- Settings sections: General, Domains, Single sign-on, App Availability, API Keys, Encryption — enterprise ones listed unconditionally and gated by their pages.
  Pinned by `nav-config.onprem.test.ts` (Groups hidden for `undefined/null`, shown for `false/true`; premise `CAPS.rbac === false`), `nav-config.cloud.test.ts` (Groups always shown; premise `CAPS.rbac === true`), `nav-config.test.ts` (App Availability under settings at `/org/org-1/settings/app-availability`, not top-level).
  Fork: if entitlement is hard-wired, show Groups unconditionally; drop "Single sign-on"; keep Domains / App Availability.

### 2.8 `lib/workspaces/page.tsx`

Imports `normalizePlan` (`@onecli/api/ee/billing/plans`); passes `plan={normalizePlan(quota.plan)}` to each `WorkspaceCard`. Minimal replacement: drop the `plan` prop entirely (see 2.9).

### 2.9 `lib/workspaces/_components/workspace-card.tsx`

Imports: `UpgradeToTeamButton` (line 45), `isPlanAtLeast, type Plan` (line 48), type `WorkspaceOwner` (line 49, `{name, email, isCurrentUser}`), `WorkspaceAccessDialog` (line 53).
Behaviour: kebab (only when `canManage`) with Rename, "Share workspace" (first `planGate.guard("workspace_sharing")`, then open), Delete (disabled when last workspace; requires typing the workspace id). `isTeam` → `WorkspaceAccessDialog`; else an `UpgradeDialogShell` "Share workspace" / pill "Team" / "Invite team members to collaborate on workspaces with shared agents, secrets, and connections." with `UpgradeToTeamButton label="Upgrade now"`.
Minimal replacement: always render `WorkspaceAccessDialog`; delete the plan branch and the upgrade button; keep the guard only with an entitlement dial.

### 2.10 `lib/workspaces/settings-page.tsx`

Imports: `WorkspaceAccessCard` (`@/ee/workspaces/_components/workspace-access-card`, line 9), `getWorkspaceQuota` (`@onecli/api/ee/services/quota-service`), `canManageWorkspace` (`@onecli/api/ee/services/authorization-service`).
Behaviour: manage-only pane; non-managers are redirected to `/w/{id}/settings/install`; `plan` from the quota service (NOT raw `subscriptionStatus`, which showed a dead-end Stripe CTA on self-host).
Minimal replacement: `WorkspaceAccessCard({workspaceId})` with no `plan` prop.

### 2.11 `lib/components/license-required-dialog.tsx`, `lib/components/enterprise-locked-card.tsx`, `lib/plan-gate.tsx`, `hooks/use-instance.ts`

All free and fully described in §0. `plan-gate.tsx` imports `usePlanUsage` (`@/ee/billing/use-plan-usage`, line 22) and lazy-imports `PlanPaywallDialog` (line 29); `plan-gate.test.tsx` mocks both. Minimal replacement: `usePlanUsage` returning `null` (or delete the plan-lock arm entirely and keep `isLocked = licenseLocked`). If the fork hard-wires entitlement it can make `PlanGateProvider` a constant no-op gate — but `workspace-access-card.test.tsx` and `plan-gate.test.tsx` then need rewriting.

### 2.12 `lib/auth/auth-provider.tsx`, `lib/auth/auth-server.ts`, `lib/auth/login-content.tsx`

Dynamic imports of `@/ee/auth/cognito-provider` (`AuthProviderImpl`), `@/ee/auth/cognito-server` (`getServerSessionImpl`), `@/ee/auth/login-content` (`LoginContent`) — each selected only when `IS_CLOUD`; the other arm is free (`auth-provider-onprem.tsx`, `auth-server-onprem.ts`, `login-content-onprem.tsx`). The onprem context supplies `isAuthenticated, isLoading, user, signIn({callbackURL?}), signOut, signInWithPassword, signUpWithPassword` and leaves `signUpWithEmail/…/signInWithSso/authError` undefined.
Minimal replacement: delete the three dispatchers' cloud arms and export the onprem implementations directly. `AuthContextValue` (`lib/auth/types.ts`) can lose the OTP/SSO optional members.

### 2.13 `lib/actions/resolve-user.ts`

Imports: `canManageAllWorkspaces, getUserRole, hasWorkspaceAccessBinding, requireRole` from `@onecli/api/ee/services/authorization-service` (lines 12-17); `ensureSsoJitMembership` (`@onecli/api/ee/sso/jit-service`, 22); `enforceSsoSession` (`@onecli/api/ee/sso/sso-enforcement`, 23).
What it needs on self-host:

- `requireRole(userId, orgId, "admin")` — throw (FORBIDDEN) for members/non-members; used by `requireOrgAdminContext()`.
- `getUserRole(userId, orgId) → OrgRole | null` and `canManageAllWorkspaces(role) → boolean` (true for owner/admin) — used so admins may target any workspace via `x-workspace-id`.
- `hasWorkspaceAccessBinding(userId, workspaceId) → boolean` — direct or group binding; the SOLE usage gate for members since "step 13b" (the creator arm was dropped), both for the header path and the `fallbackToDefault` path.
- `ensureSsoJitMembership(session, dbUser)` — called once on first-time user creation before the personal-org bootstrap; on self-host a no-op is correct.
- `enforceSsoSession(session, {id,email})` — returns `null` (allow) or `{error}`; called for EVERY resolved user; a no-op returning `null` is correct.
  Tests (`resolve-user.test.ts`) mock all three ee modules and pin: header org wins; foreign org header ignored; headerless call refuses without `fallbackToDefault`; with fallback a member with no created workspace resolves to the oldest membership org; a created workspace still wins over the membership fallback.
  Same trio pattern in `lib/workspaces/actions.ts` (`enforceSsoSession`, `getUserRole`, workspace-service list/create, `getWorkspaceQuota`), `lib/account/actions.ts` (`enforceSsoSession`; `normalizePlan/getPlanConfig` only to compute audit-log retention days → replace with a constant), `lib/team/actions.ts` (`requireRole, getUserRole`, team-service `listMembers/removeMember/findDeletablePersonalWorkspaces`), `ee/settings/actions.ts` (`enforceSsoSession`).

### 2.14 `lib/user-plan.tsx` and `lib/onboarding/onboarding-layout.tsx`

Both lazy-import `getSubscriptionStatus` from `@/ee/billing/actions` strictly AFTER a `CAPS.billing` early return. `checkDashboardRedirect()` is a hard no-op without billing (`user-plan.onprem.test.ts` pins zero context resolutions); `getCurrentPlan()` returns `null` without billing; onboarding layout bounces home without touching the billing action (`onboarding-layout.onprem.test.tsx`). Minimal replacement: delete the billing arms; `getCurrentPlan` may stay as `async () => null` if the granular pickers are kept.

### 2.15 `lib/onboarding/actions.ts`

Imports `notifyDiscord` from `@onecli/api/ee/notifications/discord`. Replacement: no-op.

### 2.16 `lib/components/request-app-slot.tsx`, `lib/granular-access/index.ts`, `lib/policy-editor/resource-scope.tsx`, `lib/api/app-availability.ts`

Covered in §1.12/§1.13. `lib/api/app-availability.ts` only documents that the org config client lives in ee; it has no import.

### 2.17 Route files that are pure re-exports of ee pages

`app/create-org/{page,layout}.tsx`, `app/review/login/page.tsx`, `(admin)/settings/general/page.tsx`, `(admin)/billing/page.tsx`, `(admin)/usage/page.tsx`, `app/claim/page.tsx`, `app/auth/login/sso/page.tsx`, `(admin)/groups/page.tsx`, `(admin)/settings/{domains,sso,app-availability}/page.tsx`, `app/aws-marketplace/{fulfill/route.ts,register/page.tsx,register/register-form.tsx}` — replace targets or delete routes per the verdicts above.

---

## 3. Appendices

### 3a. Every `@/ee/*` and `@onecli/api/ee/*` import used by free web code

| Import path                                                                                                                                                                                | Symbol(s)                                                                                                                 | Free consumer(s)                                                                                                                     | Minimal replacement behaviour                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `@/ee/account/create-org-layout`                                                                                                                                                           | default                                                                                                                   | `app/create-org/layout.tsx`                                                                                                          | keep (TRIM) or delete route                                           |
| `@/ee/account/create-org-page`                                                                                                                                                             | default                                                                                                                   | `app/create-org/page.tsx`                                                                                                            | keep (TRIM) or delete route                                           |
| `@/ee/apps/request-app-slot`                                                                                                                                                               | `RequestAppSlot`                                                                                                          | `lib/components/request-app-slot.tsx`                                                                                                | delete the cloud arm; use `LocalRequestAppSlot`                       |
| `@/ee/app-availability/app-availability-page`                                                                                                                                              | default                                                                                                                   | `(admin)/settings/app-availability/page.tsx`                                                                                         | KEEP page                                                             |
| `@/ee/auth/cognito-provider`                                                                                                                                                               | `AuthProviderImpl` (dynamic)                                                                                              | `lib/auth/auth-provider.tsx`                                                                                                         | delete; use onprem provider                                           |
| `@/ee/auth/cognito-server`                                                                                                                                                                 | `getServerSessionImpl` (dynamic)                                                                                          | `lib/auth/auth-server.ts`                                                                                                            | delete; use onprem server                                             |
| `@/ee/auth/login-content`                                                                                                                                                                  | `LoginContent` (dynamic)                                                                                                  | `lib/auth/login-content.tsx`                                                                                                         | delete; use onprem login                                              |
| `@/ee/auth/sso-login-content`                                                                                                                                                              | `SsoLoginContent`                                                                                                         | `app/auth/login/sso/page.tsx`                                                                                                        | delete route                                                          |
| `@/ee/billing/billing-route`                                                                                                                                                               | default                                                                                                                   | `(admin)/billing/page.tsx`                                                                                                           | delete route                                                          |
| `@/ee/billing/api-requests-page`                                                                                                                                                           | default                                                                                                                   | `(admin)/usage/page.tsx`                                                                                                             | delete route                                                          |
| `@/ee/billing/actions`                                                                                                                                                                     | `getSubscriptionStatus` (dynamic)                                                                                         | `lib/user-plan.tsx`, `lib/onboarding/onboarding-layout.tsx`                                                                          | delete billing arms (already behind `CAPS.billing`)                   |
| `@/ee/billing/quota-actions`                                                                                                                                                               | `getResourceQuota`, `ResourceQuota`                                                                                       | `create-agent-button`, `create-secret-button`, `invite-button`                                                                       | resolve `{atLimit:false, limit:Infinity, …}` or remove                |
| `@/ee/billing/_components/quota-limit-dialog`                                                                                                                                              | `QuotaLimitDialog`                                                                                                        | same three + `create-workspace-button`                                                                                               | render null or remove                                                 |
| `@/ee/billing/_components/plan-badge`                                                                                                                                                      | `PlanBadge`                                                                                                               | `dashboard-header.tsx`                                                                                                               | remove (inside `CAPS.billing`)                                        |
| `@/ee/billing/use-plan-usage`                                                                                                                                                              | `usePlanUsage`                                                                                                            | `dashboard-header.tsx`, `lib/plan-gate.tsx`                                                                                          | return `null` or remove                                               |
| `@/ee/billing/_components/sidebar-quota`                                                                                                                                                   | `SidebarQuota`                                                                                                            | `dashboard-sidebar.tsx`                                                                                                              | remove (inside `CAPS.billing`)                                        |
| `@/ee/billing/_components/over-quota-banner`                                                                                                                                               | `OverQuotaBanner` (static + dynamic)                                                                                      | `org-layout.tsx`, `workspace-layout.tsx`                                                                                             | render null or remove                                                 |
| `@/ee/billing/_components/plan-paywall-dialog`                                                                                                                                             | `PlanPaywallDialog` (dynamic)                                                                                             | `lib/plan-gate.tsx`                                                                                                                  | remove plan-lock arm                                                  |
| `@/ee/billing/_components/upgrade-to-team-button`                                                                                                                                          | `UpgradeToTeamButton`                                                                                                     | `workspace-card.tsx`                                                                                                                 | remove with the plan branch                                           |
| `@/ee/billing/aws-marketplace/actions`, `…/token-cookie`                                                                                                                                   | `hasPendingMarketplaceToken`, `completeMarketplaceRegistration`, `AWS_MP_TOKEN_COOKIE`                                    | `app/aws-marketplace/**`                                                                                                             | delete routes                                                         |
| `@/ee/granular-access`                                                                                                                                                                     | `granularAccessConfigs` (+ types)                                                                                         | `lib/granular-access/index.ts`                                                                                                       | export the map from free configs (pickers optional)                   |
| `@/ee/policy-editor/_components/resource-scope-fields`                                                                                                                                     | `ResourceScopeFieldsProps` (type), `ResourceScopeFields` (dynamic, cloud only)                                            | `lib/policy-editor/resource-scope.tsx`                                                                                               | move the type to free code; keep onprem hint                          |
| `@/ee/groups/groups-page`                                                                                                                                                                  | default                                                                                                                   | `(admin)/groups/page.tsx`                                                                                                            | KEEP page                                                             |
| `@/ee/settings/org-general-page`                                                                                                                                                           | default                                                                                                                   | `(admin)/settings/general/page.tsx`                                                                                                  | KEEP page                                                             |
| `@/ee/settings/org-domains-page`                                                                                                                                                           | default                                                                                                                   | `(admin)/settings/domains/page.tsx`                                                                                                  | KEEP page                                                             |
| `@/ee/settings/org-sso-page`                                                                                                                                                               | default                                                                                                                   | `(admin)/settings/sso/page.tsx`                                                                                                      | delete route                                                          |
| `@/ee/team/actions`                                                                                                                                                                        | `getUserOrgRole`                                                                                                          | `dashboard-sidebar.tsx` (and ee plan-badge)                                                                                          | non-throwing role read, default `"member"`                            |
| `@/ee/team/actions`                                                                                                                                                                        | `getOrgSubscriptionStatus`                                                                                                | `lib/team/team-page.tsx`                                                                                                             | remove                                                                |
| `@/ee/team/_components/team-upgrade-banner`                                                                                                                                                | `TeamUpgradeBanner`                                                                                                       | `lib/team/team-page.tsx`                                                                                                             | remove                                                                |
| `@/ee/team/_components/manage-access-dialog`                                                                                                                                               | `ManageAccessDialog`                                                                                                      | `member-list.tsx`                                                                                                                    | role-only dialog (audited)                                            |
| `@/ee/team/claim-page`                                                                                                                                                                     | default                                                                                                                   | `app/claim/page.tsx`                                                                                                                 | delete route                                                          |
| `@/ee/review/reviewer-login-page`                                                                                                                                                          | default                                                                                                                   | `app/review/login/page.tsx`                                                                                                          | delete route                                                          |
| `@/ee/workspaces/_components/workspace-access-card`                                                                                                                                        | `WorkspaceAccessCard`                                                                                                     | `lib/workspaces/settings-page.tsx`                                                                                                   | KEEP (no plan prop)                                                   |
| `@/ee/workspaces/_components/workspace-access-dialog`                                                                                                                                      | `WorkspaceAccessDialog`                                                                                                   | `workspace-card.tsx`                                                                                                                 | KEEP                                                                  |
| `@onecli/api/ee/services/authorization-service`                                                                                                                                            | `getUserRole`, `requireRole`, `canManageAllWorkspaces`, `hasWorkspaceAccessBinding`, `canManageWorkspace`, type `OrgRole` | `resolve-user.ts`, `team-page.tsx`, `lib/team/actions.ts`, `lib/workspaces/actions.ts`, `settings-page.tsx`, `dashboard-sidebar.tsx` | real RBAC implementations (owner>admin>member; bindings direct/group) |
| `@onecli/api/ee/services/team-service`                                                                                                                                                     | `listMembers`, `removeMember`, `findDeletablePersonalWorkspaces`, `changeMemberRole`, type `TeamMember`                   | `lib/team/actions.ts`, `member-list.tsx`, ee team actions                                                                            | member CRUD; `TeamMember` shape as in §2.2                            |
| `@onecli/api/ee/services/workspace-service`                                                                                                                                                | `WorkspaceListItem`, `WorkspaceOwner`, list/create helpers                                                                | `lib/workspaces/actions.ts`, `workspace-card.tsx`                                                                                    | keep shapes                                                           |
| `@onecli/api/ee/services/quota-service`                                                                                                                                                    | `getWorkspaceQuota`, `canCreateOrganization`                                                                              | `lib/workspaces/actions.ts`, `settings-page.tsx`, create-org page                                                                    | `{current:0, limit:Infinity, plan}`; multi-org policy                 |
| `@onecli/api/ee/services/organization-service`                                                                                                                                             | `createOrganization`, `deleteOrganization`, `validateOrgName`                                                             | ee settings actions                                                                                                                  | keep (org lifecycle)                                                  |
| `@onecli/api/ee/services/user-provision-service`                                                                                                                                           | `findPendingProvisionByToken`                                                                                             | ee claim page                                                                                                                        | drop                                                                  |
| `@onecli/api/ee/sso/sso-enforcement`                                                                                                                                                       | `enforceSsoSession`                                                                                                       | `resolve-user.ts`, `lib/workspaces/actions.ts`, `lib/account/actions.ts`, ee settings actions                                        | `async () => null`                                                    |
| `@onecli/api/ee/sso/jit-service`                                                                                                                                                           | `ensureSsoJitMembership`                                                                                                  | `resolve-user.ts`                                                                                                                    | no-op                                                                 |
| `@onecli/api/ee/sso/saml-claims`                                                                                                                                                           | `SAML_EMAIL_CLAIM`, `SAML_NAME_CLAIM`                                                                                     | ee sso-it-panel                                                                                                                      | drop                                                                  |
| `@onecli/api/ee/billing/plans`                                                                                                                                                             | `normalizePlan`, `isPlanAtLeast`, `getPlanConfig`, `Plan`                                                                 | `plan-gate.tsx`, `team-page.tsx`, `workspaces/page.tsx`, `workspace-card.tsx`, `lib/account/actions.ts`, `lib/user-plan.tsx`         | remove call sites; retention days → constant                          |
| `@onecli/api/ee/billing/plan-features`                                                                                                                                                     | `isPremiumFeature`, `requiredPlanFor`, `PremiumFeature`                                                                   | `plan-gate.tsx`                                                                                                                      | remove plan-lock arm                                                  |
| `@onecli/api/ee/notifications/discord`                                                                                                                                                     | `notifyDiscord`                                                                                                           | `lib/onboarding/actions.ts`, ee request-app                                                                                          | no-op                                                                 |
| `@onecli/api/ee/budget/*`, `@onecli/api/ee/clients/*`, `@onecli/api/ee/billing/{stripe,subscription-plan,plan-switch,env,aws-marketplace/service}`, `@onecli/api/ee/auth/cognito-identity` | (ee-internal only)                                                                                                        | none                                                                                                                                 | drop                                                                  |

Free helpers that already provide the non-EE seam: `packages/api/src/services/workspace-access-check.ts` (`userIsOrgAdmin`, `canAccessWorkspaceAsUser`, provider-driven) used by `admin-layout.tsx` and `workspace-layout.tsx`; `packages/api/src/lib/entitlements.ts` (`isEntitled`, `ENTERPRISE_FEATURES`, `isEnterpriseFeature`).

### 3b. `next/dynamic` imports of ee modules (free → ee)

| File                                                              | Import                                                                                       | Condition                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------- |
| `lib/auth/auth-provider.tsx:13-23`                                | `@/ee/auth/cognito-provider` → `AuthProviderImpl` (`ssr:false`, spinner)                     | `IS_CLOUD`                   |
| `lib/auth/login-content.tsx:15-25`                                | `@/ee/auth/login-content` → `LoginContent` (`ssr:false`, spinner)                            | `IS_CLOUD`                   |
| `lib/auth/auth-server.ts:13-18`                                   | `import("@/ee/auth/cognito-server")` (plain lazy import, memoised)                           | `IS_CLOUD`                   |
| `lib/plan-gate.tsx:27-33`                                         | `@/ee/billing/_components/plan-paywall-dialog` → `PlanPaywallDialog` (`ssr:false`)           | rendered only on a plan lock |
| `lib/policy-editor/resource-scope.tsx:13-19`                      | `@/ee/policy-editor/_components/resource-scope-fields` → `ResourceScopeFields` (`ssr:false`) | `IS_CLOUD`                   |
| `lib/workspaces/workspace-layout.tsx:10-14`                       | `@/ee/billing/_components/over-quota-banner` → `OverQuotaBanner`                             | always rendered              |
| `lib/user-plan.tsx:54`, `lib/onboarding/onboarding-layout.tsx:58` | `import("@/ee/billing/actions")` → `getSubscriptionStatus`                                   | after `CAPS.billing` check   |
| (ee-internal) `ee/granular-access/index.ts:15-25`                 | `./github-app/policy-dialog-content`, `./dropbox/policy-dialog-content`                      | always                       |

### 3c. Test files under `apps/web` exercising ee / entitlement

| File                                                                                | Pins                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/(dashboard)/org/[orgId]/(admin)/enterprise-wrappers.onprem.test.tsx`           | Four wrappers (groups, sso, domains, app-availability): unlicensed → text "Enterprise" and NO inner page; licensed → inner page and no "Enterprise".                                                                                               |
| `ee/groups/groups-page.onprem.test.tsx`                                             | Licensed self-host: admin & owner render (no redirect); member → redirect `/org/org-1/workspaces`; unlicensed → redirect with zero role checks; premise `CAPS.rbac=false`.                                                                         |
| `ee/groups/groups-page.cloud.test.tsx`                                              | Cloud (`CAPS.rbac=true`): admin renders with no `ENTERPRISE_ENABLED`; member still redirected.                                                                                                                                                     |
| `ee/app-availability/app-availability-page.onprem.test.tsx`                         | Same four arms as groups for App Availability.                                                                                                                                                                                                     |
| `ee/app-availability/app-availability-page.cloud.test.tsx`                          | Cloud arm for App Availability.                                                                                                                                                                                                                    |
| `ee/workspaces/_components/workspace-access-card.test.tsx`                          | Real `PlanGateProvider`: unlicensed → no access fetch, "Requires a OneCLI Enterprise license", Manage access opens license dialog (`workspace_sharing`), never "Upgrade to Team" even with `plan="free"`; licensed → fetch on, share dialog opens. |
| `ee/analytics.test.tsx`                                                             | No baked PostHog/Fathom vars → children plain, no init, no script; vars set → init with key/host, Fathom `data-site`.                                                                                                                              |
| `lib/plan-gate.test.tsx`                                                            | `entitled:false` locks exactly `ENTERPRISE_FEATURES`; `guard("groups")` opens license dialog; `instance null` locks nothing; `entitled:true` locks nothing.                                                                                        |
| `lib/nav-config.onprem.test.ts`                                                     | Groups hidden while entitlement unknown, shown once known (true or false); premise `CAPS.rbac=false`.                                                                                                                                              |
| `lib/nav-config.cloud.test.ts`                                                      | Groups always shown on cloud; premise `CAPS.rbac=true`.                                                                                                                                                                                            |
| `lib/nav-config.test.ts`                                                            | App Availability is a settings entry (not top-level); Channels/Skills hosted gating; Agents/Install placement.                                                                                                                                     |
| `lib/dashboard/dashboard-sidebar.onprem.test.tsx`                                   | Mocks `getUserOrgRole→"owner"`, `SidebarQuota→null`; no hosted vocabulary without a runner; BYO agents still listed; footer shows `vtest` version.                                                                                                 |
| `lib/dashboard/dashboard-sidebar.test.tsx`                                          | Cloud twin (same ee mocks); hosted entries follow the availability wire; no version line on cloud.                                                                                                                                                 |
| `lib/dashboard/sidebar-version.onprem.test.tsx`                                     | Version caption/dialog on self-host from `GET /v1/instance` (`entitled:false` in the wire mock).                                                                                                                                                   |
| `lib/dashboard/sidebar-version.cloud.test.tsx`                                      | Version never renders on a cloud build even if the wire claims onprem.                                                                                                                                                                             |
| `lib/onboarding/onboarding-layout.onprem.test.tsx`                                  | Direct visit bounces home without touching `@/ee/billing/actions`.                                                                                                                                                                                 |
| `lib/onboarding/onboarding-layout.cloud.test.tsx`                                   | Billing edition boot: free + not onboarded → flow; completed / paid / no workspace → bounce; boot failure → `/`.                                                                                                                                   |
| `lib/user-plan.onprem.test.ts`                                                      | `checkDashboardRedirect()` is a hard no-op without billing (zero context resolutions).                                                                                                                                                             |
| `lib/team/join-page.onprem.test.tsx`                                                | `/join` branches (free invitation flow; self-host signed-out → `/auth/signup?token=`); no ee import, but pins the self-host `IS_CLOUD=false` posture.                                                                                              |
| `lib/actions/resolve-user.test.ts`                                                  | Mocks `authorization-service`, `jit-service`, `sso-enforcement`; org-context header precedence and membership fallback.                                                                                                                            |
| `lib/workspaces/actions.test.ts`                                                    | Mocks `sso-enforcement`, `workspace-service`, `authorization-service`, `quota-service`; `getActiveOrganizationId` resolution.                                                                                                                      |
| `app/auth/login/sso/sso-login-page.onprem.test.tsx`                                 | Unlicensed → `redirect("/auth/login")`; licensed → SSO form.                                                                                                                                                                                       |
| `app/claim/claim-page.onprem.test.tsx`                                              | Unlicensed → locked card and ZERO token reads; licensed → token read once, sign-in screen.                                                                                                                                                         |
| `app/aws-marketplace/edition-gate.onprem.test.ts`                                   | Fulfill route 404 with no cookie; register page notFound before session; actions refuse before reading cookies/registering.                                                                                                                        |
| `app/aws-marketplace/edition-gate.cloud.test.ts`                                    | Cloud: fulfill parks token and redirects to register; actions run.                                                                                                                                                                                 |
| `app/(dashboard)/w/[workspaceId]/agents/_components/agents-content.onprem.test.tsx` | Self-host create door opens hosted creation from the chevron, never a sales call (mocks `@/ee/billing/quota-actions` and `quota-limit-dialog` in the sibling `agents-content.test.tsx`).                                                           |

### 3d. Verdict summary

| Area                                                        | Verdict         | One-line reason                                                                      |
| ----------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| Groups (list, members, name/delete dialogs)                 | KEEP            | fork ships groups; drop SCIM/IdP badge copy                                          |
| Role mappings                                               | TRIM            | works without IdP but is IdP-flavoured; keep only if group→role automation is wanted |
| App availability                                            | KEEP (optional) | org-wide allowlist over members+groups; drop the plan CTA                            |
| Org settings → General                                      | KEEP            | rename / id copy / owner delete; drop subscriptionStatus + SSO enforcement           |
| Org settings → Domains                                      | KEEP            | domain verification ships; strip SSO copy                                            |
| Org settings → SSO / Require SSO / SCIM                     | DROP            | no SSO/SCIM; Cognito-shaped                                                          |
| Workspace access card + dialog                              | KEEP            | sharing ships; delete plan branch                                                    |
| `getUserOrgRole`, `changeTeamMemberRole`, `requireOrgAdmin` | KEEP            | free code depends on them                                                            |
| `getOrgSubscriptionStatus`, TeamUpgradeBanner               | DROP            | billing                                                                              |
| ManageAccessDialog                                          | TRIM            | role only                                                                            |
| Claim / provisioning                                        | DROP            | invitations + Google login cover it                                                  |
| Create org                                                  | TRIM            | only if multi-org wanted                                                             |
| Auth (Cognito, OTP, SSO login, lookup, cleanup, amplify)    | DROP            | onprem arms already exist                                                            |
| Billing (all)                                               | DROP            | provide null/no-op stand-ins for free consumers                                      |
| Budget                                                      | DROP            | dormant upstream                                                                     |
| Granular access pickers + ResourceScopeFields               | TRIM            | keep the config map export; pickers optional (GitHub only)                           |
| Request app (cloud)                                         | DROP            | local arm exists                                                                     |
| Reviewer login                                              | DROP            | app-store backdoor                                                                   |
| Analytics                                                   | DROP            | self-host no-op anyway                                                               |
