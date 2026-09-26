"use client";

import { useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { coveredBy } from "@onecli/api/lib/resource-axis";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { DialogBody, DialogFooter } from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyDialogContentProps } from "../types";

/** Above this many repositories the list gets a search box. */
const SEARCH_THRESHOLD = 8;

type ScopeMode = "all" | "selected";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** `owner/name` → `owner` (lower-cased: GitHub logins are case-insensitive). */
const ownerOf = (repo: string): string =>
  (repo.split("/")[0] ?? "").toLowerCase();

const shortName = (repo: string): string => repo.split("/").pop() ?? repo;

interface RepoRow {
  id: string;
  /** Saved in the policy but no longer offered by the installation. */
  stale: boolean;
  /** Owner differs from the installation account. */
  crossOwner: boolean;
  /** Outside the organization's boundary for this connection. */
  outsideBoundary: boolean;
}

/**
 * The GitHub App repository picker: "All repositories" or a checked subset of
 * the installation's `metadata.repos`, policy shape `{ repositories: string[] }`
 * (`null` = unrestricted).
 *
 * Two guard rails beyond the boundary rule the spec shares with every
 * provider:
 *
 * - **Owner validation.** The gateway's shared mint sends GitHub bare
 *   repository NAMES for the installation's own account, so a saved
 *   `other-org/api` would silently scope to the installation owner's `api`.
 *   Every selected entry must therefore carry the installation account's login
 *   (`metadata.username`); a cross-owner entry blocks Save with an inline
 *   error until removed. When the connection carries no account login there is
 *   nothing to validate against, and the check is skipped.
 * - **Stale entries.** A repository saved earlier but no longer on the
 *   installation stays visible (checked, removable) so the operator can see
 *   why the API would refuse the write, instead of the row vanishing.
 */
export const GithubAppPolicyDialogContent = ({
  metadata,
  policy,
  onPolicyChange,
  onSave,
  onCancel,
  orgBoundary = null,
}: PolicyDialogContentProps) => {
  const [query, setQuery] = useState("");
  const searchId = useId();

  const repos = useMemo(
    () => (isStringArray(metadata.repos) ? metadata.repos : []),
    [metadata.repos],
  );
  const account =
    typeof metadata.username === "string" && metadata.username.length > 0
      ? metadata.username.toLowerCase()
      : null;

  const selected = useMemo(
    () =>
      policy && isStringArray(policy.repositories) ? policy.repositories : [],
    [policy],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const mode: ScopeMode = policy === null ? "all" : "selected";

  const rows = useMemo<RepoRow[]>(() => {
    const offered = new Set(repos);
    const stale = selected.filter((repo) => !offered.has(repo));
    return [...stale, ...repos].map((id) => ({
      id,
      stale: !offered.has(id),
      crossOwner: account !== null && ownerOf(id) !== account,
      outsideBoundary: !coveredBy(id, orgBoundary),
    }));
  }, [repos, selected, account, orgBoundary]);

  const crossOwnerSelected = rows.filter(
    (row) => row.crossOwner && selectedSet.has(row.id),
  );
  const canSave = mode === "all" || crossOwnerSelected.length === 0;

  const showSearch = rows.length > SEARCH_THRESHOLD;
  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery
    ? rows.filter((row) => row.id.toLowerCase().includes(normalizedQuery))
    : rows;

  const setMode = (next: ScopeMode) => {
    if (next === mode) return;
    onPolicyChange(next === "all" ? null : { repositories: [] });
  };

  const toggle = (repo: string, checked: boolean) => {
    const next = checked
      ? [...selected, repo]
      : selected.filter((r) => r !== repo);
    // The last one off reverts to unrestricted: an empty list is not a scope
    // anyone can mean (the API refuses it, the gateway reads it as deny-all).
    onPolicyChange(next.length > 0 ? { repositories: next } : null);
  };

  return (
    <>
      <DialogBody className="space-y-4">
        <div
          role="group"
          aria-label="Repository scope"
          className="grid grid-cols-2 gap-1 rounded-lg border p-1"
        >
          {(
            [
              { value: "all", label: "All repositories" },
              { value: "selected", label: "Selected repositories" },
            ] as const
          ).map((option) => {
            const pressed = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={pressed}
                onClick={() => setMode(option.value)}
                className={cn(
                  "focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
                  pressed
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {mode === "selected" && (
          <div className="space-y-2">
            {showSearch && (
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                  aria-hidden
                />
                <Input
                  id={searchId}
                  type="search"
                  aria-label="Search repositories"
                  placeholder="Search repositories..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-8"
                />
              </div>
            )}

            {rows.length === 0 ? (
              <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
                This connection grants access to all repositories, so there are
                no individual repositories to narrow to.
              </p>
            ) : visible.length === 0 ? (
              <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
                No repositories match &ldquo;{query.trim()}&rdquo;
              </p>
            ) : (
              <ul
                aria-label="Repositories"
                className="max-h-64 divide-y overflow-y-auto rounded-md border"
              >
                {visible.map((row) => {
                  const checked = selectedSet.has(row.id);
                  // Boundary and owner rules block only the CHECK direction:
                  // an already-selected entry must stay removable.
                  const blocked =
                    !checked &&
                    (row.outsideBoundary || row.crossOwner || row.stale);
                  const note = row.crossOwner
                    ? checked
                      ? `Owned by ${ownerOf(row.id)}, not this installation. Remove it.`
                      : `Owned by ${ownerOf(row.id)}, not this installation`
                    : row.stale
                      ? "No longer on this installation. Remove it."
                      : row.outsideBoundary
                        ? checked
                          ? "No longer allowed by your organization. Remove it."
                          : "Not allowed by your organization"
                        : null;
                  const checkboxId = `${searchId}-${row.id}`;
                  return (
                    <li
                      key={row.id}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 text-sm",
                        blocked && "opacity-60",
                      )}
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={checked}
                        disabled={blocked}
                        aria-label={row.id}
                        onCheckedChange={(value) =>
                          toggle(row.id, value === true)
                        }
                      />
                      <label
                        htmlFor={checkboxId}
                        className={cn(
                          "flex min-w-0 flex-1 flex-col",
                          blocked ? "cursor-not-allowed" : "cursor-pointer",
                        )}
                      >
                        <span className="truncate font-medium">
                          {shortName(row.id)}
                        </span>
                        <span className="text-muted-foreground truncate text-xs">
                          {row.id}
                        </span>
                      </label>
                      {note && (
                        <span
                          className={cn(
                            "shrink-0 text-xs",
                            checked && (row.crossOwner || row.stale)
                              ? "text-destructive"
                              : "text-muted-foreground",
                          )}
                        >
                          {note}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <p className="text-muted-foreground text-xs" aria-live="polite">
              {selected.length} of {rows.length} selected
            </p>

            {crossOwnerSelected.length > 0 && (
              <p
                role="alert"
                className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs"
              >
                {crossOwnerSelected.length === 1
                  ? "This repository belongs"
                  : "These repositories belong"}{" "}
                to a different owner than this installation
                {account ? ` (${account})` : ""}:{" "}
                {crossOwnerSelected.map((row) => row.id).join(", ")}. A scope is
                enforced by repository name within the installation account, so
                remove {crossOwnerSelected.length === 1 ? "it" : "them"} to
                save.
              </p>
            )}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onSave} disabled={!canSave}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
};
