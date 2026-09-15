"use client";

import { FeatureComingSoonDialog } from "@/lib/components/feature-coming-soon-dialog";

export interface WorkspaceAccessDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Phase 0 stand-in for the workspace-sharing dialog (people/groups → role
 * bindings). Workspace sharing is KEEP per the v2 migration plan; the real
 * dialog is Phase 3 work.
 */
export const WorkspaceAccessDialog = ({
  open,
  onOpenChange,
}: WorkspaceAccessDialogProps) => (
  <FeatureComingSoonDialog
    open={open}
    onOpenChange={onOpenChange}
    title="Manage workspace access"
    description="Sharing this workspace with teammates and groups is available in a later phase."
  />
);
