import type { SessionEnforcer } from "../../providers/types";

/**
 * Enterprise "require SSO" is dropped: no session is ever denied on that
 * ground. Kept as a `SessionEnforcer` so the free call sites (account and
 * workspace server actions, the api-server's session route) stay untouched.
 */
export const enforceSsoSession: SessionEnforcer = async () => null;
