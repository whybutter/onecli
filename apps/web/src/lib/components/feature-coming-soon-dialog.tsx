"use client";

import { Clock } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { UpgradeDialogShell } from "@/lib/components/upgrade-dialog-shell";

export interface FeatureComingSoonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The feature's display title, e.g. "Manage access". */
  title: string;
  /** One or two sentences on what this dialog will do once it ships. */
  description?: string;
}

/**
 * A dialog-shaped placeholder for a v2-migration Phase 0 stand-in feature —
 * the modal equivalent of `ComingSoonCard`. Used where a free component
 * expects to open a dialog (manage access, workspace sharing, resource
 * scoping) but the real dialog isn't built yet.
 */
export const FeatureComingSoonDialog = ({
  open,
  onOpenChange,
  title,
  description = "This is available in a later phase.",
}: FeatureComingSoonDialogProps) => (
  <UpgradeDialogShell
    open={open}
    onOpenChange={onOpenChange}
    icon={<Clock aria-hidden="true" className="text-muted-foreground size-6" />}
    title={title}
    description={description}
    footer={
      <Button className="w-full" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    }
  />
);
