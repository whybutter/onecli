import type { Plan } from "./plans";

/**
 * Features the hosted platform gated by plan. Self-host has never plan-gated
 * anything, and this build has no billing, so every premium feature is
 * required at the lowest plan — i.e. always available.
 */
export type PremiumFeature =
  | "policy.manual_approval"
  | "policy.rate_limit"
  | "policy.deny_mode"
  | "sso"
  | "groups";

export const PREMIUM_FEATURES: Record<PremiumFeature, Plan> = {
  "policy.manual_approval": "free",
  "policy.rate_limit": "free",
  "policy.deny_mode": "free",
  sso: "free",
  groups: "free",
};

export const isPremiumFeature = (value: string): value is PremiumFeature =>
  value in PREMIUM_FEATURES;

export const requiredPlanFor = (feature: PremiumFeature): Plan =>
  PREMIUM_FEATURES[feature];

/** The premium feature a policy-rule action maps to, if any. */
export const ruleActionFeature = (action: string): PremiumFeature | null => {
  switch (action) {
    case "manual_approval":
      return "policy.manual_approval";
    case "rate_limit":
      return "policy.rate_limit";
    case "block":
      return "policy.deny_mode";
    case "identity_directory_group":
      return "groups";
    default:
      return null;
  }
};
