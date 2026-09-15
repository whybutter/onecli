/**
 * Billing is dropped in this build — `usePlanUsage()` always returns `null`,
 * so this banner is never shown. Null stand-in kept only so
 * `lib/dashboard/org-layout.tsx` and `lib/workspaces/workspace-layout.tsx`
 * compile unchanged.
 */
export const OverQuotaBanner = () => null;
