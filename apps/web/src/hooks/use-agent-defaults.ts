"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as agentDefaults from "@/lib/api/agent-defaults";
import type { ConnectionGrantInput } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/keys";

// The workspace-level default-connections template: what a brand-new agent
// in this workspace is granted automatically. Mutations are audited
// server-side (withAudit), so — same as useConnections — there is no
// client-side gateway call here, just a refetch of the template.

export const useAgentDefaults = (workspaceId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.agentDefaults.list(workspaceId),
    queryFn: () => agentDefaults.list(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });

export const useSetAgentDefault = (workspaceId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      input,
    }: {
      connectionId: string;
      input: ConnectionGrantInput;
    }) => agentDefaults.set(workspaceId, connectionId, input),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.agentDefaults.list(workspaceId),
      });
    },
    onError: () => toast.error("Failed to update the default"),
  });
};

export const useRemoveAgentDefault = (workspaceId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      agentDefaults.remove(workspaceId, connectionId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.agentDefaults.list(workspaceId),
      });
    },
    onError: () => toast.error("Failed to remove the default"),
  });
};
