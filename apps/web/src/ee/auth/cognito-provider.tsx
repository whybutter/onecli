import type { ReactNode } from "react";

/**
 * Cognito/Amplify auth is cloud-only and unreachable here —
 * `lib/auth/auth-provider.tsx` only lazy-loads this arm when `IS_CLOUD`,
 * which is permanently false in this onprem-only fork (the self-hosted
 * `OnpremAuthProvider` is what actually mounts). Passes children through
 * rather than rendering `null`: if this were ever reached despite the
 * `IS_CLOUD` guard, dropping the whole app tree would be a worse failure
 * mode than a provider that does nothing.
 */
export const AuthProviderImpl = ({ children }: { children: ReactNode }) => (
  <>{children}</>
);
