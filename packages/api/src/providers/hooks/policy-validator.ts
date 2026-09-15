import type { PolicyTargetInput } from "../../validations/policy";
import { createEditionSlot } from "../edition-state";
import { onpremPolicyValidator } from "../../services/policy-onprem-validator";

export interface PolicyValidator {
  validate(
    organizationId: string,
    provider: string,
    metadata: Record<string, unknown> | null,
    policy: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Optional gate over a rule's targets, run on create/update (never publish —
   * a pre-existing row must not brick a whole-scope publish). Absent =
   * permissive; neither edition default implements it (the one-catalog
   * gateway enforces every provider) — it remains an injection point.
   */
  validateTargets?(targets: PolicyTargetInput[]): Promise<void>;
}

// Edition default when nothing is injected: cloud gates granular access by
// plan + provider shape — injected by `ensureEditionDefaults()`, keeping the
// plan/quota graph out of client bundles; onprem validates the SAME provider
// shape with no licence gate in front (resource scoping is entitled in this
// build; the validator module is client-safe and stays a static import). The
// `policyValidator` option and `initPolicyValidator` remain as overrides for
// tests (null resets to the edition default).
const slot = createEditionSlot<PolicyValidator>(
  "policyValidator",
  () => onpremPolicyValidator,
);

export const initPolicyValidator = (v: PolicyValidator | null) => slot.init(v);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultPolicyValidator = (v: PolicyValidator) =>
  slot.setCloudDefault(v);

export const getPolicyValidator = (): PolicyValidator => slot.get();
