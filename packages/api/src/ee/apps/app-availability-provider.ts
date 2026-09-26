import type { AppAvailabilityProvider } from "../../providers/types";

/**
 * App availability (the org allowlist) is deferred (v2 migration decision 3).
 * `null` means "unrestricted": every app is connectable in every workspace,
 * which is what the free onprem default already answered.
 */
export const appAvailability: AppAvailabilityProvider = {
  getAvailableProviders: async () => null,
};
