"use server";

export interface RegistrationResult {
  ok: boolean;
  error?: string;
  status?: string;
  entitledAgents?: number;
  contractExpiresAt?: string | null;
}

/**
 * AWS Marketplace billing is cloud-only and permanently dropped in this
 * onprem-only fork. The free `register/page.tsx` already 404s before
 * calling this (`if (!IS_CLOUD) notFound()`), so `false` here is never
 * actually reached — kept truthful-shaped for compilation.
 */
export const hasPendingMarketplaceToken = async (): Promise<boolean> => false;

/**
 * Same reachability note as above: the register form's parent page 404s
 * first on a self-host. Refuses rather than throws so a stray client call
 * gets a normal error message instead of an unhandled rejection.
 */
export const completeMarketplaceRegistration =
  async (): Promise<RegistrationResult> => ({
    ok: false,
    error: "Not available on this deployment.",
  });
