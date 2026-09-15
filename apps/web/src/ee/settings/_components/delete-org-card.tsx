"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import type { OrgRole } from "@onecli/api/ee/services/authorization-service";
import { deleteOrganizationAction } from "@/ee/settings/actions";

export interface DeleteOrgCardProps {
  orgId: string;
  orgName: string;
  role: OrgRole;
  workspaces: { id: string; name: string | null }[];
}

/**
 * Owner-only destructive delete, with a per-workspace acknowledgement
 * checklist and a confirm-by-id input — matches `web-ee-behaviour.md` §1.3,
 * minus the chat-app uninstall copy (`ee/settings/actions.ts`'s `OrgData`
 * doesn't carry `channelApps`, per the WP-A plan's TRIM note).
 */
export const DeleteOrgCard = ({
  orgId,
  orgName,
  role,
  workspaces,
}: DeleteOrgCardProps) => {
  const [open, setOpen] = useState(false);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const allAcked = workspaces.every((w) => acked.has(w.id));
  const canConfirm = allAcked && confirmText.trim() === orgId && !pending;

  const handleOpenChange = (value: boolean) => {
    setOpen(value);
    if (!value) {
      setAcked(new Set());
      setConfirmText("");
    }
  };

  const toggle = (id: string) =>
    setAcked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleDelete = () => {
    if (!canConfirm) return;
    startTransition(async () => {
      const result = await deleteOrganizationAction(orgId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(result.data.redirectTo);
    });
  };

  return (
    <>
      <Card className="border-destructive/40 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold">Delete organization</h3>
            <p className="text-muted-foreground text-sm">
              Permanently delete this organization and all of its workspaces.
              Make sure you have a backup if you want to keep your data.
            </p>
          </div>
          <Button
            variant="destructive"
            disabled={role !== "owner" || pending}
            onClick={() => setOpen(true)}
          >
            Delete organization
          </Button>
        </div>
      </Card>

      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete organization</AlertDialogTitle>
            <AlertDialogDescription>
              This action <strong>cannot</strong> be undone. This will
              permanently delete the <strong>{orgName}</strong> organization and
              remove all of its workspaces.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {workspaces.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                Acknowledge each workspace that will be deleted:
              </p>
              <div className="max-h-48 overflow-y-auto rounded-md border">
                {workspaces.map((workspace) => (
                  <label
                    key={workspace.id}
                    className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0"
                  >
                    <Checkbox
                      checked={acked.has(workspace.id)}
                      onCheckedChange={() => toggle(workspace.id)}
                    />
                    <span className="text-foreground text-sm font-medium">
                      {workspace.name ?? "Untitled"}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <p className="text-sm font-medium">
              Type{" "}
              <code className="bg-muted cursor-text select-text rounded px-1.5 py-0.5 font-mono">
                {orgId}
              </code>{" "}
              to confirm.
            </p>
            <Input
              placeholder="Enter the organization ID"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={!canConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending
                ? "Deleting..."
                : "I understand, delete this organization"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
