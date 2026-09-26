import { createEditionSlot } from "../edition-state";
import type { ResourceScope } from "../../services/resource-scope";

/** Scope of a policy-rule write — the same shape as `ResourceScope`. */
export type RuleWriteScope = ResourceScope;

/**
 * Authorizes which policy-rule actions an org may write. The onprem default
 * allows every action: approvals, rate limits and deny mode are free on
 * self-host, and the group-identity arm (the one action the enterprise
 * licence used to gate) is entitled in this build. The cloud default is the
 * plan-based gate — injected by `ensureEditionDefaults()`, keeping the
 * quota/plan service out of client bundles. The `ruleActionGate` option and
 * `initRuleActionGate` remain as overrides for tests (null resets to the
 * edition default).
 *
 * Called by the policy-rule service itself, so every write path — HTTP routes,
 * server actions, workspace scope and org scope — is gated in one place and no
 * caller can bypass it.
 */
export interface RuleActionGate {
  assertAllowed(scope: RuleWriteScope, actions: string[]): Promise<void>;
}

const onpremRuleActionGate: RuleActionGate = {
  assertAllowed: async () => {},
};

const slot = createEditionSlot<RuleActionGate>(
  "ruleActionGate",
  onpremRuleActionGate,
);

export const initRuleActionGate = (a: RuleActionGate | null) => slot.init(a);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultRuleActionGate = (a: RuleActionGate) =>
  slot.setCloudDefault(a);

export const getRuleActionGate = (): RuleActionGate => slot.get();
