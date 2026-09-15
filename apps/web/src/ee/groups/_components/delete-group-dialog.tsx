"use client";

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

export interface DeleteGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  pending: boolean;
  onConfirm: () => void;
}

export const DeleteGroupDialog = ({
  open,
  onOpenChange,
  groupName,
  pending,
  onConfirm,
}: DeleteGroupDialogProps) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete &ldquo;{groupName}&rdquo;?</AlertDialogTitle>
        <AlertDialogDescription>
          Members keep their accounts. Only the group and anything granted
          through it goes away.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          onClick={(e) => {
            // Stay open until the caller closes it on success — a failed
            // delete must not silently dismiss the confirmation.
            e.preventDefault();
            onConfirm();
          }}
          disabled={pending}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        >
          {pending ? "Deleting..." : "Delete"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
