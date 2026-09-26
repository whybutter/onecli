/**
 * Enterprise entitlement — the single source of truth for "may this
 * deployment run enterprise features".
 *
 * This build is always entitled. The `ee/` directories are Apache-licensed
 * here (v2 migration, principle 3): there is no licence flag, no
 * `ENTERPRISE_ENABLED`, and every unlicensed arm in the free code collapses
 * to the licensed one. The feature registry stays because the web's plan
 * gate and the refusal-message helper still key on it.
 *
 * This module is pure and dependency-free — safe to import from any runtime.
 */

/**
 * The features the enterprise licence used to cover, with the human label the
 * locked UI and refusal messages use. Deliberately NOT the same set as the
 * billing `PremiumFeature`s: deny-mode, manual approvals and rate limits are
 * plan-gated on cloud but free on self-host, so they have no key here. The
 * `sso` and `groups` keys are shared with `PremiumFeature` on purpose — the
 * rule-action mapping (`identity_directory` → `groups`) works for both dials.
 */
export const ENTERPRISE_FEATURES = {
  sso: "Single sign-on, verified domains & SCIM",
  groups: "Directory groups",
  granular_access: "Resource-level access",
  workspace_sharing: "Workspace sharing",
  app_availability: "App availability control",
  multi_org: "Multiple organizations",
  rbac: "Role-based access control",
  provisioning: "Member provisioning",
  members_directory: "Members directory API",
  budget: "Spend budgets",
  ha: "Multi-instance operation",
} as const;

export type EnterpriseFeature = keyof typeof ENTERPRISE_FEATURES;

/** Narrows an arbitrary string to a known enterprise feature. */
export const isEnterpriseFeature = (
  value: string,
): value is EnterpriseFeature => value in ENTERPRISE_FEATURES;

/**
 * Kept so suites written against the two-state world still compile. There
 * is only one state now; the override is accepted and ignored.
 */
export const initEntitlementForTests: (
  value: boolean | null,
) => void = () => {};

/** Whether THIS process is entitled to enterprise features: always. */
export const isEntitled = (): boolean => true;
