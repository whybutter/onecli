# Slice D — Shared design-system primitives: approved implementation plan

**Status:** vetted and approved by the orchestrator. Implement this.

## Orchestrator rulings

| Question                                      | Ruling                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where do the new components live?             | **`apps/web/src/components/` — approved. Zero diff in `packages/ui/`.** The planner's reasoning holds: these are copy/spacing policy, not shadcn primitives, and `@onecli/ui` has one consumer so the boundary buys nothing. |
| Is `src/components/` outside the fenced list? | **Approved anyway.** Two brand-new files; no parallel slice has reason to create `empty-state.tsx` or `table-card.tsx`. Fence updated.                                                                                       |
| Dashed vs. visually-inert migration           | **Marco's decision: match the spec — use `dashed` for section-level empty states.** The migration is intentionally NOT pixel-neutral. See "Intended visual deltas".                                                          |
| Merge the three notice components?            | **Approved as planned:** `AdminOnlyNotice`/`LocalModeNotice` become thin `EmptyState variant="card"` calls; do NOT collapse the four files into one prop-driven component; leave `ReadOnlyNotice` alone.                     |

**Owned files:** `apps/web/src/components/empty-state.tsx` (new), `apps/web/src/components/table-card.tsx` (new), `apps/web/src/app/(dashboard)/groups/_components/*`, `apps/web/src/app/(dashboard)/team/_components/*`.

**`packages/ui/` is read-only for this slice. Zero diff there.**

---

## Decision 1 — placement

`apps/web/src/components/` holds feature-agnostic app-wide widgets (`secret-input.tsx`, `project-access-dialog.tsx`); `src/lib/components/` holds feature-coupled ones (`approvals/`, `condition-builder/`, `unavailable-badge.tsx`). Presentation-only + feature-agnostic → `src/components/`. `(dashboard)/_components/` is the shell and is owned by Slice A.

**`cva` is NOT a dependency of `apps/web`** (only of `packages/ui`), and no app file uses it. Variant styles must be a plain `Record`-keyed class lookup merged with `cn()` from `@onecli/ui/lib/utils`. **Do not add `class-variance-authority` to `apps/web`.**

Both files: one component per file, const arrow, named exports, **no `"use client"`** — both are pure and must stay RSC-compatible, like `page-header.tsx`.

## Decision 2 — how the shadcn constraint is satisfied

**No file under `packages/ui/src/components/` is modified.** The table-header restyle comes from an app-level _wrapper_ styling shadcn's `TableHead` from the outside via descendant utility variants — CLAUDE.md explicitly permits both "customizing via `className`" and "wrapping in your own component".

Rejected alternatives, for the record:

- **Adding a CVA variant to `TableHead`** — `table.tsx` contains no `cva` at all (plain `cn()`). Introducing one plus a `variant` prop is "modifying component structure", not "adding a variant to a CVA definition". Not compliant.
- **`className` at every call site** — permitted, but re-inlines the duplication this slice exists to remove. Retained only as a documented escape hatch.

`TableCard` carries:

```
[&_thead_th]:uppercase [&_thead_th]:text-[11px] [&_thead_th]:tracking-wider
[&_thead_th]:text-muted-foreground [&_thead_th]:font-medium
```

### ⚠️ Gating risk — verify in the browser, do not assume

`TableHead`'s base class includes `text-foreground`, and our override lives on an **ancestor**, so `tailwind-merge` cannot dedupe it. The outcome depends on stylesheet order (arbitrary-variant utilities emitting after plain ones). This is the same mechanism shadcn itself relies on (`[&_svg]:size-4` on `Button`), so it should win — **but it must be verified with devtools on a real `<th>`, not eyeballed.**

Fallbacks in order: (1) `[&_thead_th]:text-muted-foreground!` (Tailwind v4 important suffix); (2) export `TABLE_HEAD_CLASS` and pass it as `className` on each `TableHead`, where `TableHead`'s own `cn()` merges deterministically.

**Export `TABLE_HEAD_CLASS` regardless** — it's the escape hatch for tables that can't use the `TableCard` frame.

---

## Component 1 — `EmptyState`

```tsx
type EmptyStateCopy =
  | { things: string; title?: never } // renders `No ${things} yet`
  | { title: string; things?: never }; // escape hatch for non-inventory states

export type EmptyStateProps = {
  icon: LucideIcon;
  /** Copy formula: `<Verb> a <thing> to <outcome>.` One sentence, ends in a period. */
  description: string;
  variant?: "card" | "dashed"; // default "card"
  action?: ReactNode;
  className?: string;
} & EmptyStateCopy;
```

**The copy formula is encoded in the type, not just documented.** The happy path is `things` (`things="groups"` → `No groups yet`), making drift impossible; `title` is a mutually-exclusive escape hatch for non-inventory states (`Admins only`). The `description` formula can only be a JSDoc convention.

`action` exists because `projects-empty-state.tsx` already puts a Create button inside the box.

|              | `card`                                                                | `dashed`                                                  |
| ------------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| frame        | `<Card>` + `gap-0 py-0` overrides, `min-h-[230px]`                    | `div`, `rounded-xl border border-dashed`, `min-h-[140px]` |
| badge        | `size-12` `bg-muted` circle, `mb-4`                                   | `size-10` circle, `mb-3`                                  |
| icon         | `size-6 text-muted-foreground`                                        | `size-5 text-muted-foreground`                            |
| title / body | `text-sm font-medium` / `text-muted-foreground mt-1 max-w-xs text-xs` | same                                                      |

**Critical implementation note:** use `<Card>` but **neutralize `gap-6`/`py-6`**. `Card`'s base is `flex flex-col gap-6 rounded-xl border py-6`. Today's call sites pass `py-12` but leave `gap-6` alive, so existing empty states render with 24px flex gaps stacked on top of the `mb-4`/`mt-1` margins. Pass `gap-0 py-0` and control all spacing inside `EmptyState`.

Both variants keep the circular badge — the org spec shows Groups' dashed empty states with one, so no `plain glyph` mode and no extra prop.

**Variant selection rule (document in JSDoc):**

- `card` = the empty state **replaces the whole page surface** (admin-only, local-mode, a page whose only content is the list).
- `dashed` = the empty state sits **inside a page that has other content** (a section among sections).

## Component 2 — `TableCard`

```tsx
export const TableCard = ({ className, ...props }: React.ComponentProps<"div">) => ( … );
export const TABLE_HEAD_CLASS = "text-muted-foreground text-[11px] font-medium tracking-wider uppercase";
```

Renders `<Card className={cn("overflow-hidden gap-0 p-0", HEAD_VARIANTS, className)}>` and nothing else — children are the `<Table>` tree unchanged. No custom props (per CLAUDE.md, use `React.ComponentProps<"div">` directly).

Standardizes on the **`Card` idiom** (used by 5 of 6 sites) over `activity`/`budgets`' `<div className="rounded-lg border overflow-hidden">`. **Do not special-case radius** — the spec's ~10px is `rounded-lg` while `Card` is `rounded-xl` (14px), but matching the spec here would make table cards inconsistent with sibling cards on the same page. Radius alignment is a global `--radius` question; follow-up.

---

## Migration list — exhaustive, nothing outside it

`groups/_components/`

1. `groups-table.tsx` — empty → `variant="dashed" things="groups" icon={UsersRound}`; frame → `TableCard`.
2. `role-mappings-section.tsx` — **two** boxed states plus a table: `isError` "Admins only" → `variant="dashed" title="Admins only" icon={Lock}`; empty → `variant="dashed" things="role mappings" icon={Shuffle}`; frame → `TableCard`. **Leave the `isPending` skeleton card alone.**
3. `admin-only-notice.tsx` → `variant="card" title="Admins only" icon={Lock}`. **JSDoc preserved verbatim** — it records the 403-is-the-admin-authority rationale.
4. `local-mode-notice.tsx` → `variant="card"`. Its body uses `max-w-md` vs `EmptyState`'s `max-w-xs` — accept the narrower measure and let it grow taller.
5. `group-members-dialog.tsx` — **deliberately excluded.** Its empty state is borderless and in-dialog (`py-8`, `size-10`, no frame); supporting it needs a third `plain` variant. Documented exception.

`team/_components/` 6. `members-table.tsx` — frame → `TableCard` (no empty state; always ≥1 member). 7. `pending-invitations.tsx` — empty → `variant="dashed" things="invitations" icon={Mail}`; frame → `TableCard`. **Leave the `error` card as-is** — it's an alert, not an empty state, and `team-content.tsx`'s comment explains why the two must never be conflated. 8. `admin-only-notice.tsx` → `variant="card"`. 9. `local-mode-notice.tsx` → `variant="card"`.

Net: 4 tables re-framed, 7 empty states extracted, ~8 files touched, `packages/ui` untouched.

**Explicitly NOT touched:** `connections/**`, `projects/**`, `policy-editor/**`, `install/**`, `settings/**`, `agents/**`, `activity/**`, `lib/components/**`, `components/project-access-admin-notice.tsx`. (~26 centered-empty-state occurrences exist repo-wide; 8 are in scope.)

---

## Sequencing — step 2 gates the slice

1. Create `empty-state.tsx`; verify both variants render.
2. Create `table-card.tsx`; migrate **one** table (`members-table.tsx`) and **immediately verify in devtools that the header color override wins.** This is the gating check. If it loses, apply the `!` fallback before migrating anything else.
3. Migrate the remaining 3 tables.
4. Migrate the 4 notice files (mechanical, lowest risk).
5. Migrate the 3 inline empty states.
6. `pnpm check`, then the visual pass.

## Intended visual deltas — enumerate these in the PR so reviewers don't read them as regressions

Marco approved a spec-faithful migration, so this is **not** pixel-neutral:

- (a) `Card`'s `gap-6` removed → existing empty states tighten by ~24px per gap.
- (b) Card-variant boxes grow to `min-h-[230px]` (today `py-12` + content ≈ 186px).
- (c) **Section-level empty states in groups/team change from solid card to dashed border** — this is the approved design change, taken from the org spec, not a side effect.

## Verification

No RTL/Storybook/Playwright harness exists (`apps/web` has vitest with 2 pure-logic tests), so verification is manual + diff-based:

1. `pnpm check` and `pnpm --filter @onecli/web test`.
2. **Class-equivalence table in the PR description** — before/after computed class strings for each of the 8 migrated states. Catches silent drops (e.g. `max-w-md` → `max-w-xs`) a single-viewport screenshot misses.
3. **Screenshot pairs at 1440px**, `/groups` and `/team`, **light and dark** (all colors move to tokens).
4. **DevTools on a real `<th>`**: computed `color`, `font-size: 11px`, `text-transform: uppercase`. Confirm `text-foreground` is actually overridden, not just similar-looking in light mode.
5. Reaching the states: a seeded instance gives groups/role-mappings/invitations empty for free. Local-mode notices need an instance without Google OAuth env. AdminOnly branches can be approximated by temporarily inverting the `isError` guard and reverting — the components are pure and presentational.

## Risks

1. **Header override may lose the cascade** — highest probability, cheapest fix. Slice is gated on step 2.
2. **`dashed` would be dead code** without the groups/team migration — this is what gives it a first consumer before slices G/H arrive.
3. **Slice H (Members restyle) re-touches `team/_components/*`.** H must run after D, or merge into it.
4. **Parallel slices will inline fresh copies of the old idioms** while this lands. Unavoidable at this scope; the follow-up list is the cleanup.

## Follow-ups — NOT in this slice

1. Second-wave migration once parallel slices land: `connections/**` (5 sites incl. the boxed-text-only and unboxed variants), `projects-empty-state.tsx`, `agents/**` (4 sites), `settings/project/_components/local-mode-notice.tsx`, `project-access-admin-notice.tsx`, `policy-reflect/*`, `policy-editor.tsx`.
2. `TableCard` adoption for `activity-table.tsx` and `budgets-list.tsx`, retiring the `rounded-lg border` idiom entirely.
3. A `Notice`/callout primitive for `ReadOnlyNotice`, `pending-invitations`' error card, and `setup-status-card` — genuinely different from `EmptyState`.
4. `variant="plain"` (borderless) for in-dialog empty states (`group-members-dialog`, `approvals-popover`, `manage-permissions-dialog`).
5. Row height (~46px target vs our `p-2`/`h-10`) and card radius (10px vs `Card`'s 14px) — global token questions the shadcn rule pushes toward a theme-level change.
6. Icon parity nits (role mappings target uses shield-check, we use `Shuffle`) — deliberately unchanged to keep the diff extraction-shaped.
