import type { ResourceHooks } from "../../providers/hooks/resource-hooks";

/** Plan quotas on agents and secrets are dropped: nothing to assert. */
export const eeResourceHooks: ResourceHooks = {
  beforeCreateAgent: async () => {},
  beforeCreateSecret: async () => {},
};
