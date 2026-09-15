export interface SsoOrgIdentity {
  organizationId: string;
  connectionId: string;
  cognitoProviderName: string;
}

export type FindSsoOrgForIdentity = (
  identityProviders: string[],
  email: string,
) => Promise<SsoOrgIdentity | null>;

/**
 * "Can this session's IdP vouch for the email's domain?" — always no. There
 * are no SSO connections or verified domains in this build, so the identity
 * conflict resolver falls back to its other proofs (verified email, Google).
 */
export const findSsoOrgForIdentity: FindSsoOrgForIdentity = async () => null;
