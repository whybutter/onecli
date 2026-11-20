import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@onecli/db";
import { canManageWorkspace } from "@onecli/api/ee/services/authorization-service";
import { getServerSession } from "@/lib/auth/server";
import { PageHeader } from "@dashboard/page-header";
import { RenameWorkspaceForm } from "./_components/rename-workspace-form";
import { WorkspaceTimezoneCard } from "./_components/workspace-timezone-card";
import { WorkspaceAccessCard } from "@/ee/workspaces/_components/workspace-access-card";
import { AgentDefaultsCard } from "@/ee/workspaces/_components/agent-defaults-card";
import { DeleteWorkspaceButton } from "./_components/delete-workspace-button";

export const metadata: Metadata = {
  title: "Workspace Settings",
};

interface Props {
  workspaceId: string;
}

export default async function WorkspaceSettingsPage({ workspaceId }: Props) {
  const session = await getServerSession();
  if (!session) redirect("/auth/login");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  if (!user) redirect("/auth/login");

  // Settings is a MANAGE surface (rename / share / delete). Fetch the workspace
  // within the user's active org membership for its display fields, then gate on
  // management authority — an owner-role binding OR org admin/owner (step 13c).
  // (Previously scoped to createdByUserId, which also wrongly excluded org admins.)
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      organization: {
        members: { some: { userId: user.id, status: { not: "suspended" } } },
      },
    },
    select: {
      id: true,
      name: true,
      timezone: true,
      organizationId: true,
    },
  });
  if (!workspace) redirect("/org");
  const [canManage, orgWorkspaceCount] = await Promise.all([
    canManageWorkspace(user.id, workspace.id),
    db.workspace.count({ where: { organizationId: workspace.organizationId } }),
  ]);
  if (!canManage) return null;

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Rename or delete this workspace. Usage is in the sidebar under your organization."
      />
      <RenameWorkspaceForm
        workspaceId={workspace.id}
        currentName={workspace.name}
      />
      <WorkspaceTimezoneCard
        workspaceId={workspace.id}
        currentTimezone={workspace.timezone}
      />
      <WorkspaceAccessCard workspaceId={workspace.id} />
      <AgentDefaultsCard workspaceId={workspace.id} canManage={canManage} />
      <DeleteWorkspaceButton
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        organizationId={workspace.organizationId}
        isLastWorkspace={orgWorkspaceCount <= 1}
      />
    </div>
  );
}
