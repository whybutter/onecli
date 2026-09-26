import { createEditionSlot } from "../edition-state";

export interface ResourceHooks {
  beforeCreateAgent(organizationId: string, workspaceId: string): Promise<void>;
  beforeCreateSecret(organizationId: string): Promise<void>;
  /**
   * Optional — omitted editions get no post-create step (today: none do; the
   * fork wires the workspace agent-default-connections template here). Kept
   * optional rather than required so an edition implementing `ResourceHooks`
   * outside this package doesn't break the moment this method is added —
   * it opts in on its own schedule.
   */
  afterCreateAgent?(
    organizationId: string,
    workspaceId: string,
    agentId: string,
  ): Promise<void>;
}

const noopResourceHooks: ResourceHooks = {
  beforeCreateAgent: async () => {},
  beforeCreateSecret: async () => {},
};

// Edition default: cloud enforces plan quotas before agent/secret creation —
// injected by `ensureEditionDefaults()`, keeping the quota service (and its
// Redis client) out of client bundles; onprem has no quotas.
const slot = createEditionSlot<ResourceHooks>(
  "resourceHooks",
  noopResourceHooks,
);

/** Test seam — the uniform slot override (`null` resets to the edition default). */
export const initResourceHooks = (h: ResourceHooks | null) => slot.init(h);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultResourceHooks = (h: ResourceHooks) =>
  slot.setCloudDefault(h);

export const getResourceHooks = (): ResourceHooks => slot.get();
