"use server";

import { revalidatePath } from "next/cache";
import {
  getUserRole,
  requireRole,
  type OrgRole,
} from "@onecli/api/ee/services/authorization-service";
import { changeMemberRole } from "@onecli/api/ee/services/team-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { safeAction, type ActionResult } from "@/lib/safe-action";

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
 * Change a member's role from the "Manage access" dialog. Admin-gated (an
 * admin may promote/demote a member but not touch the owner — the service
 * itself refuses that, `changeMemberRole` is owner-immutable); audited as
 * the one web-layer audit event under `ee/` (the API route equivalent audits
 * server-side, but this path calls the service directly, so the web layer
 * must audit it itself). `revalidatePath` refreshes the server-rendered
 * member list after the dialog closes.
 */
export const changeTeamMemberRole = async (
  targetUserId: string,
  newRole: "admin" | "member",
): Promise<ActionResult> =>
  safeAction(async () => {
    const { userId, userEmail, organizationId } = await resolveOrgContext();
    await requireRole(userId, organizationId, "admin");
    await withAudit(
      () => changeMemberRole(organizationId, targetUserId, newRole),
      () => ({
        organizationId,
        userId,
        userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.MEMBER,
        metadata: { targetUserId, newRole },
      }),
    );
    revalidatePath("/", "layout");
  });
