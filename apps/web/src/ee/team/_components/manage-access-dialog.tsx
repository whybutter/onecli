"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { RoleSelect } from "@/lib/team/_components/role-select";
import { changeTeamMemberRole } from "@/ee/team/actions";

export interface ManageAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  email: string;
  currentRole: "admin" | "member";
  /**
   * SSO break-glass exemption is permanently dropped in this fork (no SSO).
   * Kept on the props interface so `member-list.tsx` needs no changes; the
   * dialog itself never reads it.
   */
  currentSsoExempt: boolean;
  /**
   * Group→role mapping automation is out of scope for this fork's Groups
   * page (no `/org/role-mappings` router mounted). Kept on the props
   * interface for the same reason as `currentSsoExempt`; always falsy in
   * practice today.
   */
  roleManagedByIdp?: boolean;
}

/**
 * "Manage access" — trimmed to role-only per the v2 migration plan (SSO
 * break-glass exemption and the IdP-managed-role helper text are dropped
 * along with SSO/SCIM). The owner row never renders this dialog (member-list
 * only opens it for non-owner, non-self rows), so `currentRole` is always
 * "admin" | "member".
 */
export const ManageAccessDialog = ({
  open,
  onOpenChange,
  userId,
  email,
  currentRole,
}: ManageAccessDialogProps) => {
  const router = useRouter();
  const [role, setRole] = useState(currentRole);
  const [busy, setBusy] = useState(false);

  // Reset to the member's current role each time the dialog opens, so a
  // previous edit that was cancelled doesn't linger into the next open.
  useEffect(() => {
    if (open) setRole(currentRole);
  }, [open, currentRole]);

  const isDirty = role !== currentRole;

  const handleSave = async () => {
    if (!isDirty || busy) return;
    setBusy(true);
    const result = await changeTeamMemberRole(userId, role);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Access updated");
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>Update access for {email}.</DialogDescription>
        </DialogHeader>

        <RoleSelect
          id="manage-role"
          value={role}
          onValueChange={setRole}
          disabled={busy}
        />

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={busy}
            disabled={!isDirty || busy}
          >
            {busy ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
