import type { AuthUser } from "@/lib/auth/types";

/**
 * Cognito session resolution is cloud-only and unreachable here —
 * `lib/auth/auth-server.ts` only lazy-loads this arm when `IS_CLOUD`, which
 * is permanently false in this onprem-only fork (the self-hosted
 * `getServerSessionImpl` in `auth-server-onprem.ts` is what actually runs).
 */
export const getServerSessionImpl = async (): Promise<AuthUser | null> => null;
