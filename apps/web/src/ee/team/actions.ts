"use server";

import { ServiceError } from "@onecli/api/services/errors";
import {
  getUserRole,
  type OrgRole,
} from "@onecli/api/ee/services/authorization-service";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import type { ActionResult } from "@/lib/safe-action";

/**
 * The caller's role in their active organization, fetched client-side to
 * pick sidebar nav entries. Fails closed to the least-privileged role on ANY
 * error (no org context yet, transient failure, ...) rather than throwing —
 * the sidebar always needs a role to render.
 */
export const getUserOrgRole = async (): Promise<OrgRole> => {
  try {
    const { userId, organizationId } = await resolveOrgContext();
    const role = await getUserRole(userId, organizationId);
    return role ?? "member";
  } catch {
    return "member";
  }
};

/**
 * Billing is dropped in this build — every organization is effectively on
 * the top plan, so `team-page.tsx`'s upgrade-banner condition never fires.
 * Kept truthful-shaped (a real subscription status string) rather than
 * throwing, since the caller only ever compares it via `normalizePlan`,
 * which already collapses every input to the same plan.
 */
export const getOrgSubscriptionStatus = async (): Promise<string> => "active";

/**
 * Role changes through the team "Manage access" dialog are Phase 3 work
 * (the dialog itself is a placeholder in Phase 0 — see
 * `_components/manage-access-dialog.tsx`). Throwing here keeps the free
 * Members page compiling and rendering its member list; nothing in Phase 0
 * calls this action from a reachable UI path.
 */
export const changeTeamMemberRole: (
  targetUserId: string,
  newRole: "admin" | "member",
) => Promise<ActionResult> = async () => {
  throw new ServiceError(
    "BAD_REQUEST",
    "Changing a member's role is not available until Phase 3.",
  );
};
