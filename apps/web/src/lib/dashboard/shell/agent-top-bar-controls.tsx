"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { withWorkspacePrefix } from "@/lib/navigation";
import { useAgentActivityPaths } from "@/lib/dashboard/use-agent-activity-paths";
import { AgentActionsMenu } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/agent-actions-menu";
import { AgentDetailsDialog } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-details-dialog";
import type { AgentPageAgent } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-page-frame";

/**
 * What the old agent page header carried besides the name, kept on the new
 * shell in the top bar: the agent's menu (Details,
 * activity, rename, restart, delete).
 */
export const AgentTopBarControls = ({ agent }: { agent: AgentPageAgent }) => {
  const pathname = usePathname();
  const router = useRouter();
  const activityPaths = useAgentActivityPaths();
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <>
      <AgentActionsMenu
        agent={agent}
        onDetails={() => setDetailsOpen(true)}
        onViewActivity={() => router.push(activityPaths.activity(agent.id))}
        onDeleted={() => router.replace(withWorkspacePrefix(pathname, ""))}
      />
      <AgentDetailsDialog
        agent={agent}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </>
  );
};
