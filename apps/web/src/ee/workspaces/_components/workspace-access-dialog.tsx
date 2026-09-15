"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Badge } from "@onecli/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import {
  useWorkspaceAccess,
  useSetWorkspaceAccess,
} from "@/hooks/use-workspace-access";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { useGroups } from "@/hooks/use-groups";
import { toast } from "sonner";

export interface WorkspaceAccessDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Role = "owner" | "member";

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((v) => b.has(v));

// Candidates exclude the platform's own service identities — never a human
// to share with.
const isRealPerson = (email: string) => !email.endsWith("@onecli.internal");

export const WorkspaceAccessDialog = ({
  workspaceId,
  open,
  onOpenChange,
}: WorkspaceAccessDialogProps) => {
  const access = useWorkspaceAccess(workspaceId, open);
  const members = useOrgMembersList(open);
  const groups = useGroups(open);
  const setAccess = useSetWorkspaceAccess();

  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    new Set(),
  );
  const [roles, setRoles] = useState<Map<string, Role>>(new Map());
  const [search, setSearch] = useState("");

  // The FROZEN baseline the dirty-check compares against — seeded once per
  // open, from `access.data`. Held in state (not a ref) so it is safe to
  // read during render; a background refetch (e.g. another tab's write)
  // replacing `access.data` must not shift what "dirty" means mid-edit,
  // which is exactly why this is seeded once rather than derived live.
  const [baseline, setBaseline] = useState<{
    users: Set<string>;
    groups: Set<string>;
    roles: Map<string, Role>;
  } | null>(null);

  useEffect(() => {
    if (!open) {
      setBaseline(null);
      setSearch("");
      return;
    }
    if (baseline || !access.data) return;
    const users = new Set(access.data.users.map((u) => u.userId));
    const groupIds = new Set(access.data.groups.map((g) => g.groupId));
    const roleMap = new Map<string, Role>(
      access.data.users.map((u) => [u.userId, u.role]),
    );
    setBaseline({ users, groups: groupIds, roles: roleMap });
    setSelectedUserIds(new Set(users));
    setSelectedGroupIds(new Set(groupIds));
    setRoles(new Map(roleMap));
    // `baseline` is deliberately excluded: it is the guard this effect
    // itself sets, not a re-seed trigger — including it would re-run (and
    // no-op) on every seed, which is harmless but noisy; excluding it keeps
    // the effect's intent ("run when the open/data pair changes") explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, access.data]);

  const initialLoading = access.isPending || members.isPending;
  const accessError = access.isError;

  const dirty = (() => {
    if (!baseline) return false;
    if (!setsEqual(selectedUserIds, baseline.users)) return true;
    if (!setsEqual(selectedGroupIds, baseline.groups)) return true;
    for (const userId of selectedUserIds) {
      if (
        (roles.get(userId) ?? "member") !==
        (baseline.roles.get(userId) ?? "member")
      ) {
        return true;
      }
    }
    return false;
  })();

  const creatorUserId = access.data?.users.find((u) => u.isOwner)?.userId;

  const candidates = (members.data ?? []).filter((m) => isRealPerson(m.email));
  const filteredCandidates = search
    ? candidates.filter(
        (m) =>
          (m.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
          m.email.toLowerCase().includes(search.toLowerCase()),
      )
    : candidates;

  const toggleUser = (userId: string, checked: boolean) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
    setRoles((prev) => {
      const next = new Map(prev);
      if (checked) {
        if (!next.has(userId)) next.set(userId, "member");
      } else {
        next.delete(userId);
      }
      return next;
    });
  };

  const toggleGroup = (groupId: string, checked: boolean) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
  };

  const setRole = (userId: string, role: Role) => {
    setRoles((prev) => new Map(prev).set(userId, role));
  };

  const noBindings = selectedUserIds.size === 0 && selectedGroupIds.size === 0;
  const hasBindings = !noBindings;
  const hasOwnerUser = [...selectedUserIds].some(
    (id) => (roles.get(id) ?? "member") === "owner",
  );
  const showSeeded = baseline !== null && !initialLoading && !accessError;

  const handleSave = () => {
    if (!dirty) return;
    setAccess.mutate(
      {
        workspaceId,
        users: [...selectedUserIds].map((userId) => ({
          userId,
          role: roles.get(userId) ?? "member",
        })),
        groupIds: [...selectedGroupIds],
      },
      {
        onSuccess: () => {
          toast.success("Workspace access updated");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !setAccess.isPending && onOpenChange(o)}
    >
      <DialogContent className="p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Manage workspace access</DialogTitle>
          <DialogDescription>
            Choose who can access this workspace. Members can use it; owners
            (and org admins) can also rename, share, or delete it.
          </DialogDescription>
        </DialogHeader>

        {initialLoading ? (
          <div className="flex items-center justify-center px-6 py-12">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : accessError ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load access</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Something went wrong. Close and reopen to try again.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6 px-6">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">People</h3>
                <span
                  className="text-muted-foreground text-xs"
                  aria-live="polite"
                >
                  {selectedUserIds.size} of {candidates.length} selected
                </span>
              </div>
              {candidates.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No one to add. Invite teammates to your organization first.
                </p>
              ) : (
                <>
                  <Input
                    placeholder="Filter people..."
                    aria-label="Filter people by name or email"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <div className="max-h-[min(15rem,28vh)] overflow-y-auto rounded-md border">
                    {filteredCandidates.length === 0 ? (
                      <p className="text-muted-foreground p-3 text-sm">
                        No people match &ldquo;{search}&rdquo;
                      </p>
                    ) : (
                      filteredCandidates.map((m) => {
                        const checked = selectedUserIds.has(m.userId);
                        const displayName = m.name ?? m.email;
                        return (
                          <div
                            key={m.userId}
                            className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(c) =>
                                toggleUser(m.userId, c === true)
                              }
                              aria-label={`Share with ${displayName}`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <p className="truncate text-sm font-medium">
                                  {displayName}
                                </p>
                                {m.userId === creatorUserId && (
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px]"
                                  >
                                    Creator
                                  </Badge>
                                )}
                              </div>
                              {m.name && (
                                <p className="text-muted-foreground truncate text-xs">
                                  {m.email}
                                </p>
                              )}
                            </div>
                            {checked && (
                              <Select
                                value={roles.get(m.userId) ?? "member"}
                                onValueChange={(v) =>
                                  setRole(m.userId, v as Role)
                                }
                              >
                                <SelectTrigger
                                  className="h-8 w-28 border-none shadow-none"
                                  aria-label={`Role for ${displayName}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="member">Member</SelectItem>
                                  <SelectItem value="owner">Owner</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Groups</h3>
              {groups.isPending ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                </div>
              ) : (groups.data ?? []).length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No groups yet. Create groups on the Groups page.
                </p>
              ) : (
                <div className="max-h-[min(11rem,22vh)] overflow-y-auto rounded-md border">
                  {(groups.data ?? []).map((g) => (
                    <div
                      key={g.id}
                      className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                    >
                      <Checkbox
                        checked={selectedGroupIds.has(g.id)}
                        onCheckedChange={(c) => toggleGroup(g.id, c === true)}
                        aria-label={`Share with ${g.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{g.name}</p>
                        <p className="text-muted-foreground text-xs">
                          {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {showSeeded && noBindings && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                No one will be able to use this workspace. Only org admins will
                reach it.
              </p>
            )}
            {showSeeded && hasBindings && !hasOwnerUser && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                No workspace owner set. Only org admins will be able to manage
                this workspace.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="px-6 pb-6">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={setAccess.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              initialLoading || accessError || !dirty || setAccess.isPending
            }
          >
            {setAccess.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
