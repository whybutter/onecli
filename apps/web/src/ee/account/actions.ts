"use server";

import { revalidatePath } from "next/cache";
import { db } from "@onecli/db";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import { validateOrgName } from "@onecli/api/services/organization-service";
import { createOrganization } from "@onecli/api/ee/services/organization-service";
import { enforceSsoSession } from "@onecli/api/ee/sso/sso-enforcement";
import { getServerSession } from "@/lib/auth/server";
import { setDefaultOrgCookie } from "@/lib/auth/set-active-scope";
import { safeAction, type ActionResult } from "@/lib/safe-action";

const requireUser = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, email: true },
  });
  if (!user) throw new Error("User not found");
  // Server actions are POST endpoints any authenticated session can invoke —
  // mirror the /v1/auth/session "require SSO" enforcement here too.
  const denial = await enforceSsoSession(session, user);
  if (denial) throw new Error(denial.error);
  return user;
};

/**
 * "Create a new organization": the shared bootstrap (org + owner membership +
 * default workspace), audited, then the new org becomes the session's default
 * so the redirect lands inside it. No cap — multi-org is uncapped in this
 * edition. A duplicate name surfaces as the service's own conflict message.
 */
export const createOrganizationAction = async (
  name: string,
): Promise<ActionResult<{ redirectTo: string }>> =>
  safeAction(async () => {
    const user = await requireUser();
    const orgName = validateOrgName(name);

    const created = await withAudit(
      () => createOrganization(user.id, user.email, orgName),
      (result) => ({
        organizationId: result.organization.id,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.ORGANIZATION,
        metadata: {
          organizationId: result.organization.id,
          workspaceId: result.workspace.id,
          name: orgName,
        },
      }),
    );

    await setDefaultOrgCookie(created.organization.id);
    revalidatePath("/", "layout");

    return { redirectTo: `/org/${created.organization.id}/workspaces` };
  });
