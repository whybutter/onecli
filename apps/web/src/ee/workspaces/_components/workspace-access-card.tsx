"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { WorkspaceAccessDialog } from "./workspace-access-dialog";

export interface WorkspaceAccessCardProps {
  workspaceId: string;
}

const summaryText = (
  data: { users: { isOwner: boolean }[]; groups: unknown[] } | undefined,
): string => {
  if (!data) return "Not shared yet";
  const people = data.users.filter((u) => !u.isOwner).length;
  const groups = data.groups.length;
  if (people === 0 && groups === 0) return "Not shared yet";
  const parts: string[] = [];
  if (people > 0) parts.push(`${people} ${people === 1 ? "person" : "people"}`);
  if (groups > 0) parts.push(`${groups} ${groups === 1 ? "group" : "groups"}`);
  return parts.join(" · ");
};

/**
 * Workspace sharing summary + entry point into the manage-access dialog. No
 * plan branch: this fork has no license dial and no plan tiers, so the card
 * is always the "shared" arm — see `workspace-access-dialog.tsx` for the
 * actual bindings editor.
 */
export const WorkspaceAccessCard = ({
  workspaceId,
}: WorkspaceAccessCardProps) => {
  const [open, setOpen] = useState(false);
  const access = useWorkspaceAccess(workspaceId, true);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace access</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">
            Share this workspace with teammates and groups. Members can use it;
            owners and org admins can also manage it.
          </p>
          {access.isPending ? (
            <Skeleton className="mt-1.5 h-4 w-32" />
          ) : access.isError ? (
            <p className="text-destructive mt-1.5 text-sm">
              Couldn&apos;t load sharing
            </p>
          ) : (
            <p className="mt-1.5 text-sm font-medium">
              {summaryText(access.data)}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Manage access
        </Button>
      </CardContent>
      <WorkspaceAccessDialog
        workspaceId={workspaceId}
        open={open}
        onOpenChange={setOpen}
      />
    </Card>
  );
};
