import type { TeamHooks } from "../../providers/hooks/team-hooks";

/**
 * Seat caps are a billing concept this build has none of, and group→role
 * reconciliation arrives with groups in a later phase. Both hooks are the
 * same no-op pair the free onprem default installs, so injecting this on an
 * always-entitled self-host changes nothing.
 */
export const eeTeamHooks: TeamHooks = {
  beforeInviteMember: async () => {},
  afterMemberJoined: async () => {},
};
