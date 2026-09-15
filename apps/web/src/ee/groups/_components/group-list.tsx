"use client";

import { useState } from "react";
import { Plus, UsersRound, Eye, Lock, MoreVertical } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import type { GroupRow } from "@/lib/api/types";
import {
  useGroups,
  useCreateGroup,
  useRenameGroup,
  useDeleteGroup,
} from "@/hooks/use-groups";
import { NameDialog } from "./name-dialog";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { GroupMembersDialog } from "./group-members-dialog";

export const GroupList = () => {
  const { data: groups, isPending } = useGroups();
  const createGroup = useCreateGroup();
  const renameGroup = useRenameGroup();
  const deleteGroup = useDeleteGroup();

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<GroupRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null);
  const [membersTarget, setMembersTarget] = useState<GroupRow | null>(null);

  const rows = groups ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Member groups</h2>
          <p className="text-muted-foreground text-sm">
            Managed here or synced from your identity provider.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          New group
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border">
        {isPending ? (
          <div className="flex items-center justify-center py-16">
            <Skeleton className="size-8 rounded-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
              <UsersRound className="text-muted-foreground size-6" />
            </div>
            <p className="text-sm font-medium">No groups yet</p>
            <p className="text-muted-foreground max-w-xs text-xs">
              Create a group to organize members for group-level access.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Members</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((group) => {
                // `source` is read defensively — nothing mints anything but
                // "manual" today, but this must not assume that forever.
                const isScim = group.source === "scim";
                return (
                  <TableRow key={group.id} className="hover:bg-transparent">
                    <TableCell className="max-w-xs truncate font-medium">
                      <span className="flex items-center gap-2">
                        <span className="truncate">{group.name}</span>
                        {isScim && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="gap-1">
                                <Lock className="size-3" />
                                IdP
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Managed by your identity provider. Membership and
                              name sync from the IdP
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {group.memberCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setMembersTarget(group)}
                        >
                          {isScim ? <Eye /> : <UsersRound />}
                          {isScim ? "View members" : "Manage members"}
                        </Button>
                        {!isScim && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Actions for ${group.name}`}
                              >
                                <MoreVertical className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => setRenameTarget(group)}
                              >
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleteTarget(group)}
                              >
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <NameDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New group"
        description="Groups collect members so access can be granted to a whole team at once."
        submitLabel="Create"
        pendingLabel="Creating..."
        pending={createGroup.isPending}
        onSubmit={async (name) => {
          await createGroup.mutateAsync(name);
          setCreateOpen(false);
        }}
      />

      {renameTarget && (
        <NameDialog
          open={!!renameTarget}
          onOpenChange={(open) => !open && setRenameTarget(null)}
          title="Rename group"
          description="Renaming does not change the group's members or anything granted to it."
          submitLabel="Rename"
          pendingLabel="Renaming..."
          initialName={renameTarget.name}
          pending={renameGroup.isPending}
          onSubmit={async (name) => {
            await renameGroup.mutateAsync({
              groupId: renameTarget.id,
              name,
            });
            setRenameTarget(null);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteGroupDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          groupName={deleteTarget.name}
          pending={deleteGroup.isPending}
          onConfirm={() =>
            deleteGroup.mutate(deleteTarget.id, {
              onSuccess: () => setDeleteTarget(null),
            })
          }
        />
      )}

      {membersTarget && (
        <GroupMembersDialog
          group={membersTarget}
          open={!!membersTarget}
          onOpenChange={(open) => !open && setMembersTarget(null)}
        />
      )}
    </div>
  );
};
