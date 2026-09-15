"use server";

import type { SubscriptionStatus } from "@onecli/api/ee/billing/plans";

export type BillingInterval = "month" | "year";

export interface SubscriptionState {
  status: SubscriptionStatus;
  hasStripeCustomer: boolean;
  cancelAtPeriodEnd: boolean;
  interval: BillingInterval | null;
  renewsAt: string | null;
  salesManaged: boolean;
}

/**
 * Billing is dropped in this build — always called behind `CAPS.billing`
 * (permanently false here), so this is dead code kept only for its two
 * lazy-import call sites (`lib/user-plan.tsx`, `lib/onboarding-layout.tsx`)
 * to compile. Reports a constant, non-billing state rather than throwing.
 */
export const getSubscriptionStatus: (options?: {
  fallbackToDefault?: boolean;
}) => Promise<SubscriptionState> = async () => ({
  status: "active",
  hasStripeCustomer: false,
  cancelAtPeriodEnd: false,
  interval: null,
  renewsAt: null,
  salesManaged: false,
});
