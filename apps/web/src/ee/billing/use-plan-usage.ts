"use client";

export interface ResourceUsage {
  name: string;
  current: number;
  limit: number;
}

export interface UsageOverview {
  plan: string;
  resources: ResourceUsage[];
}

export type PlanUsage = UsageOverview & {
  organizationId: string;
  organizationName: string;
};

/**
 * Billing is dropped in this build — `CAPS.billing` is permanently false, so
 * the real hook would never fetch either. Returns `null` unconditionally,
 * matching that already-inert onprem behavior, so `dashboard-header.tsx`
 * (org name / plan badge) and `dashboard-sidebar.tsx` (quota footer) compile
 * unchanged.
 */
export const usePlanUsage = (): PlanUsage | null => null;
