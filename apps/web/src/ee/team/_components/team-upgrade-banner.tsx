/**
 * Billing is dropped in this build (no plan tiers), so the "upgrade to Team"
 * banner has nothing to promote. Null stand-in — kept only so
 * `lib/team/team-page.tsx` compiles unchanged; it is never rendered in
 * practice because `getOrgSubscriptionStatus`/`isPlanAtLeast` always report
 * the top plan.
 */
export const TeamUpgradeBanner = () => null;
