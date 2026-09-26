"use server";

import { revalidatePath } from "next/cache";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import {
  activeMembershipWhere,
  validateOrgName,
} from "@onecli/api/services/organization-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import {
  getUserRole,
  type OrgRole,
} from "@onecli/api/ee/services/authorization-service";
import {
  createOrganization,
  deleteOrganization,
} from "@onecli/api/ee/services/organization-service";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import {
  setDefaultOrgCookie,
  clearDefaultOrgCookie,
} from "@/lib/auth/set-active-scope";
import { safeAction, type ActionResult } from "@/lib/safe-action";

/**
 * The org-general page's read model. Trimmed from the upstream `OrgData`
 * shape (`web-ee-behaviour.md` §1.3): no `subscriptionStatus` (no billing in
 * this fork) and no per-workspace `channelApps` (the delete dialog's
 * acknowledgement list only needs a name to check off, not the chat-app
 * uninstall copy — this fork drops that line from the confirmation text).
 */
export interface OrgData {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  workspaces: { id: string; name: string | null }[];
}

/**
 * Rename (`PATCH /v1/org` via `lib/api/org.ts` + `useUpdateOrg`) is
 * deliberately NOT a server action here — Phase 2 shipped a real HTTP route
 * for it, owner-gated server-side, so the web layer calls that instead of
 * re-implementing the write. See `ee/settings/_components/org-details-form.tsx`.
 */

/**
 * The caller's organization, for the General settings page. Returns `null`
 * when the caller has no active membership in their resolved org context —
 * defense-in-depth only: the `(admin)` route-group layout already restricts
 * this page to admin/owner, so a `null` here means a race (e.g. the caller's
 * membership was suspended between the layout check and this read), not the
 * ordinary path.
 */
export const getOrganizationData = async (): Promise<OrgData | null> => {
  const { userId, organizationId } = await resolveOrgContext();
  const role = await getUserRole(userId, organizationId);
  if (!role) return null;

  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      workspaces: {
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!organization) return null;

  return { ...organization, role };
};

/**
 * Delete the CALLER'S OWN organization outright — resolved server-side from
 * `resolveOrgContext()`, never taken from the client, so a crafted call
 * can't target an organization the caller merely used to belong to.
 * `deleteOrganization` enforces owner-only and cascades every workspace;
 * not audited here (the service logs it, and the org's own audit rows are
 * deleted with it — matching upstream's "not audited" note, since auditing
 * a row that is about to be deleted serves no reader). Redirects the caller
 * to their oldest remaining organization, or to `/create-org` if this was
 * their last one.
 */
export const deleteOrganizationAction = async (): Promise<
  ActionResult<{ redirectTo: string }>
> =>
  safeAction(async () => {
    const { userId, organizationId } = await resolveOrgContext();
    await deleteOrganization(organizationId, userId);

    const nextMembership = await db.organizationMember.findFirst({
      where: { userId, ...activeMembershipWhere },
      select: { organizationId: true },
      orderBy: { createdAt: "asc" },
    });

    let redirectTo: string;
    if (nextMembership) {
      await setDefaultOrgCookie(nextMembership.organizationId);
      redirectTo = `/org/${nextMembership.organizationId}/workspaces`;
    } else {
      await clearDefaultOrgCookie();
      redirectTo = "/create-org";
    }
    revalidatePath("/", "layout");
    return { redirectTo };
  });

/**
 * Create a new organization (multi-org has no cap in this fork — v2
 * migration Decision 2). Used by `ee/account/_components/create-org-form.tsx`
 * (WP-C's create-org page). Not resolved through `resolveOrgContext()`: the
 * caller may not have an active org context yet (or is deliberately adding a
 * second one), so this reads the session/user directly, same as
 * `lib/workspaces/actions.ts`'s own bootstrap paths.
 */
export const createOrganizationAction = async (
  name: string,
): Promise<ActionResult<{ redirectTo: string }>> =>
  safeAction(async () => {
    const session = await getServerSession();
    if (!session) throw new Error("Not authenticated");
    const user = await db.user.findUnique({
      where: { externalAuthId: session.id },
      select: { id: true, email: true },
    });
    if (!user) throw new Error("User not found");

    // Server-side validation (1-255 chars, trimmed) — the create-org form's
    // `maxLength` is a UX nicety, not the actual guard.
    const trimmed = validateOrgName(name);

    const { workspace, organization } = await withAudit(
      () => createOrganization(user.id, user.email, trimmed),
      (created) => ({
        organizationId: created.organization.id,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.ORGANIZATION,
        metadata: {
          organizationId: created.organization.id,
          workspaceId: created.workspace.id,
          name: trimmed,
        },
      }),
    );
    await db.user.update({
      where: { id: user.id },
      data: { onboardingCompletedAt: new Date() },
    });
    await setDefaultOrgCookie(organization.id);
    return { redirectTo: `/w/${workspace.id}/overview` };
  });
