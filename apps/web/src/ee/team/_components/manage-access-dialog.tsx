"use client";

import { FeatureComingSoonDialog } from "@/lib/components/feature-coming-soon-dialog";

export interface ManageAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  email: string;
  currentRole: "admin" | "member";
  currentSsoExempt: boolean;
  roleManagedByIdp?: boolean;
}

/**
 * Phase 0 stand-in for the real "Manage access" dialog (role change + SSO
 * break-glass exemption). Honors the full v2 props contract so
 * `member-list.tsx` needs no changes, but does not wire up any of the
 * actual behavior yet — that lands in Phase 3, trimmed to role-only per the
 * v2 migration plan (SSO/SCIM are permanently dropped).
 */
export const ManageAccessDialog = ({
  open,
  onOpenChange,
  email,
}: ManageAccessDialogProps) => (
  <FeatureComingSoonDialog
    open={open}
    onOpenChange={onOpenChange}
    title="Manage access"
    description={`Changing ${email}'s role is available in a later phase.`}
  />
);
