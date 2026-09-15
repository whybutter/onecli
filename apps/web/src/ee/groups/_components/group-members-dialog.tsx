"use client";

import { useEffect, useRef, useState } from "react";
import { UsersRound } from "lucide-react";
import { toast } from "sonner";
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
import { Skeleton } from "@onecli/ui/components/skeleton";
import type { GroupRow } from "@/lib/api/types";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { useGroupMembers, useSetGroupMembers } from "@/hooks/use-groups";

export interface GroupMembersDialogProps {
  group: GroupRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const matchesSearch = (
  member: { email: string; name: string | null },
  search: string,
) => {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    member.email.toLowerCase().includes(needle) ||
    (member.name ?? "").toLowerCase().includes(needle)
  );
};

/**
 * Pick which org members belong to a group. `source` is read defensively
 * (never narrowed to assume "manual" is the only value) even though nothing
 * mints a "scim" row today — a future SCIM sync must land read-only for
 * free, not require a type-narrowing fix here.
 */
export const GroupMembersDialog = ({
  group,
  open,
  onOpenChange,
}: GroupMembersDialogProps) => {
  const readOnly = group.source === "scim";
  const { data: orgMembers, isPending: orgMembersPending } =
    useOrgMembersList(open);
  const { data: groupMembers, isPending: groupMembersPending } =
    useGroupMembers(group.id, open);
  const setGroupMembers = useSetGroupMembers();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const seededRef = useRef(false);

  const loading = orgMembersPending || groupMembersPending;

  // Seed the edit buffer ONCE per open, only after both queries settle, so a
  // background refetch never clobbers an in-progress edit.
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current || loading || !groupMembers) return;
    const ids = new Set(groupMembers.map((m) => m.userId));
    setSelected(ids);
    setInitial(ids);
    seededRef.current = true;
  }, [open, loading, groupMembers]);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const members = orgMembers ?? [];
  const filtered = members.filter((m) => matchesSearch(m, search));

  const dirty =
    selected.size !== initial.size ||
    [...selected].some((id) => !initial.has(id));

  const toggle = (userId: string) => {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(members.map((m) => m.userId)));
  const clearAll = () => setSelected(new Set());

  const handleSave = () => {
    setGroupMembers.mutate(
      { groupId: group.id, userIds: [...selected] },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success("Group members updated");
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle>Members of {group.name}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? "This group is managed by your identity provider. Membership syncs from the IdP."
              : "Pick which organization members belong to this group."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-6">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Skeleton className="size-8 rounded-full" />
            </div>
          ) : members.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center text-sm">
              <UsersRound className="size-6" />
              No members found
            </div>
          ) : (
            <>
              <Input
                placeholder="Filter members..."
                aria-label="Filter members by name or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {!readOnly && (
                <div
                  className="text-muted-foreground flex items-center justify-between text-xs"
                  aria-live="polite"
                >
                  <span>
                    {selected.size} of {members.length} selected
                  </span>
                  <span className="flex gap-3">
                    <button
                      type="button"
                      className="hover:text-foreground underline-offset-2 hover:underline"
                      onClick={selectAll}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="hover:text-foreground underline-offset-2 hover:underline"
                      onClick={clearAll}
                    >
                      Clear
                    </button>
                  </span>
                </div>
              )}
              <div className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md border">
                {filtered.length === 0 ? (
                  <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                    No members match &ldquo;{search}&rdquo;
                  </p>
                ) : (
                  filtered.map((member) => (
                    <label
                      key={member.userId}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0"
                    >
                      <Checkbox
                        checked={selected.has(member.userId)}
                        onCheckedChange={() => toggle(member.userId)}
                        disabled={readOnly}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {member.name ?? member.email}
                        </p>
                        {member.name && (
                          <p className="text-muted-foreground truncate text-xs">
                            {member.email}
                          </p>
                        )}
                      </div>
                    </label>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="p-6 pt-0">
          {readOnly ? (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                loading={setGroupMembers.isPending}
                disabled={setGroupMembers.isPending || !dirty}
              >
                {setGroupMembers.isPending ? "Saving..." : "Save"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
