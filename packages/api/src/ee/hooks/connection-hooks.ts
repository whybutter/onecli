import type { ConnectionHooks } from "../../providers/hooks/connection-hooks";

/** Plan quotas on OAuth-app creation are dropped: nothing to assert. */
export const eeConnectionHooks: ConnectionHooks = {
  beforeCreate: async () => {},
};
