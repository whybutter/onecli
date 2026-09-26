import { getWorkspaceAccessChecker, type WorkspaceRef } from "../providers";
import { logger } from "../lib/logger";

/**
 * The shared "may user X open workspace P" question, provider-driven so it is
 * correct in every edition: answered through the injected
 * `WorkspaceAccessChecker` — the admin-or-binding resolution in
 * `ee/services/authorization-service.ts` (RBAC is enforced in every edition
 * of this build; see CLAUDE.md). Consumed by the auth middleware (session +
 * API-key paths) and the web's workspace layout, so every entry point gates
 * identically.
 */

/**
 * Whether a user may access a workspace: an admin/owner of the workspace's
 * organization, or an active member granted access through a WorkspaceAccess
 * binding (direct or via a group). Bindings are the sole usage gate since step
 * 13b — the creator arm was dropped.
 */
export const canAccessWorkspaceAsUser = async (
  userId: string,
  workspace: WorkspaceRef,
): Promise<boolean> => {
  const checker = getWorkspaceAccessChecker();
  // rbac ON with no checker is a host wiring bug (ensureEditionDefaults()
  // did not run in this process — instrumentation is supposed to guarantee
  // it). Denying is still right for an authz check, but doing it SILENTLY
  // once bounced every entitled self-host owner off their own workspace with
  // nothing in any log — say so loudly.
  if (!checker) {
    logger.error(
      { userId, workspaceId: workspace.id },
      "workspace access check ran with no access checker — " +
        "ensureEditionDefaults() has not run in this process; denying",
    );
    return false;
  }
  return checker.canAccessWorkspaceAsUser(userId, workspace);
};

/**
 * Whether a user holds org-admin (or owner) in an organization. The web's
 * admin-layout route guard runs on this.
 */
export const userIsOrgAdmin = async (
  userId: string,
  organizationId: string,
): Promise<boolean> => {
  const checker = getWorkspaceAccessChecker();
  if (!checker) {
    // Same wiring-bug loudness as `canAccessWorkspaceAsUser` above.
    logger.error(
      { userId, organizationId },
      "org-admin check ran with no access checker — " +
        "ensureEditionDefaults() has not run in this process; denying",
    );
    return false;
  }
  return checker.userIsOrgAdmin(userId, organizationId);
};
