import { apiGet, apiPut, apiDelete } from "./client";
import type { WorkspaceAgentDefault } from "@onecli/api/ee/services/agent-default-connections-service";
import type { ConnectionGrantInput } from "./types";

export type { WorkspaceAgentDefault };

// The workspace-level "which connections should a brand-new agent start
// with" template. WORKSPACE-scoped (`/v1/workspaces/:id/agent-defaults`,
// `requireWorkspaceManagement`) — deliberately different from
// budgets/usage's org-scoped credential requirement (risk 2); don't "fix"
// this to look like those.
const base = (workspaceId: string) =>
  `/v1/workspaces/${workspaceId}/agent-defaults`;

export const list = (workspaceId: string) =>
  apiGet<WorkspaceAgentDefault[]>(base(workspaceId));

export const set = (
  workspaceId: string,
  connectionId: string,
  input: ConnectionGrantInput,
) =>
  apiPut<WorkspaceAgentDefault[]>(
    `${base(workspaceId)}/connections/${connectionId}`,
    input,
  );

export const remove = (workspaceId: string, connectionId: string) =>
  apiDelete(`${base(workspaceId)}/connections/${connectionId}`);
