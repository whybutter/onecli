"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import type { Plan } from "@onecli/api/ee/billing/plans";
import { FeatureComingSoonDialog } from "@/lib/components/feature-coming-soon-dialog";

export interface WorkspaceAccessCardProps {
  workspaceId: string;
  plan: Plan;
}

/**
 * Phase 0 stand-in for the workspace-sharing settings card. Workspace
 * sharing is KEEP per the v2 migration plan; the real summary + "Manage
 * access" dialog are Phase 3 work.
 */
export const WorkspaceAccessCard = ({}: WorkspaceAccessCardProps) => {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace access</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Sharing this workspace with teammates and groups is available in a
          later phase.
        </p>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Manage access
        </Button>
      </CardContent>
      <FeatureComingSoonDialog
        open={open}
        onOpenChange={setOpen}
        title="Manage workspace access"
      />
    </Card>
  );
};
