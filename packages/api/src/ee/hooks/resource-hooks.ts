import type { ResourceHooks } from "../../providers/hooks/resource-hooks";
import { applyWorkspaceAgentDefaults } from "../services/agent-default-connections-service";

/**
 * Plan quotas on agents and secrets are dropped: nothing to assert before
 * creation. After creation, apply the workspace's agent-default-connections
 * template (phase2-plan WP-B) so a brand-new agent doesn't start with zero
 * access — the same door the manual attach UI writes through.
 */
export const eeResourceHooks: ResourceHooks = {
  beforeCreateAgent: async () => {},
  beforeCreateSecret: async () => {},
  afterCreateAgent: async (organizationId, workspaceId, agentId) => {
    await applyWorkspaceAgentDefaults({ workspaceId, organizationId }, agentId);
  },
};
