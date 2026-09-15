export interface CognitoIdentityClaims {
  /** Every federated IdP name attached to the token's identity, in order. */
  identityProviders: string[];
  /** The first federated IdP name, or null for native sign-ins. */
  federatedProvider: string | null;
  emailVerified: boolean;
}

export type ParseCognitoIdentityClaims = (
  payload: Record<string, unknown>,
) => CognitoIdentityClaims;

/**
 * Cognito is not an identity backend in this build. The api-server's Cognito
 * session provider is unreachable (`IS_CLOUD` is never true), so the claims
 * parser reports "no federation, unverified" — the conservative reading.
 */
export const parseCognitoIdentityClaims: ParseCognitoIdentityClaims = () => ({
  identityProviders: [],
  federatedProvider: null,
  emailVerified: false,
});
