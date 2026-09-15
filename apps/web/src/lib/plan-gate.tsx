"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface PlanGate {
  /** Whether `feature` is locked for this org/instance (drives the upfront lock UI). */
  isLocked: (feature: string) => boolean;
  /**
   * Call when the user selects a gated feature. Returns `true` when the
   * caller should abort the selection (and opens a dialog explaining why),
   * `false` when the caller should proceed.
   */
  guard: (feature: string) => boolean;
}

/**
 * This build has no billing (`CAPS.billing` is always false — `usePlanUsage`
 * never fetches) and no license dial (`isEntitled()` is always true), so
 * nothing is ever plan- or license-locked. Kept as a context/hook pair
 * rather than deleted outright because every consumer (manage-access,
 * workspace sharing, identity pickers, resource scoping) calls
 * `usePlanGate()` unconditionally; simplifying it to a constant no-op gate
 * removes the dependency on the billing/entitlement ee modules without
 * touching any of those call sites.
 */
const NOOP_GATE: PlanGate = { isLocked: () => false, guard: () => false };

const PlanGateContext = createContext<PlanGate>(NOOP_GATE);

export const PlanGateProvider = ({ children }: { children: ReactNode }) => (
  <PlanGateContext.Provider value={NOOP_GATE}>
    {children}
  </PlanGateContext.Provider>
);

export const usePlanGate = (): PlanGate => useContext(PlanGateContext);
