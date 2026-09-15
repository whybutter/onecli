import type { SessionUser } from "../../providers/types";

export type EnsureSsoJitMembership = (
  session: SessionUser,
  user: { id: string; email: string; name: string | null },
) => Promise<void>;

/**
 * SSO just-in-time membership is dropped. Called on every server-action
 * session resolve; a no-op leaves membership exactly where invitations put it.
 */
export const ensureSsoJitMembership: EnsureSsoJitMembership = async () => {};
