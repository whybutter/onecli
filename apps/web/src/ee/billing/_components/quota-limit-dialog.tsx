export interface QuotaLimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceName: string;
  current: number;
  limit: number;
  plan: string;
  organizationId: string;
}

/**
 * Billing is dropped in this build, and `getResourceQuota` always reports
 * `atLimit: false`, so this dialog is never reachable — kept as a null
 * stand-in only so the free create buttons (agents, secrets, members,
 * workspaces) compile unchanged.
 */
export const QuotaLimitDialog = ({}: QuotaLimitDialogProps) => null;
