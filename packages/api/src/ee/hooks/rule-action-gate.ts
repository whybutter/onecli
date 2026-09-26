import type { RuleActionGate } from "../../providers/hooks/rule-action-gate";

/**
 * Every policy-rule action is allowed. The plan-gated premium actions
 * (approvals, rate limits, deny mode) are free on self-host, and the one
 * licensed action (`identity_directory_group`) is entitled in this build.
 */
export const eeRuleActionGate: RuleActionGate = {
  assertAllowed: async () => {},
};
