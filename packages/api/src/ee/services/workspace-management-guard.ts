import { db } from "@onecli/db";
import type { AuthContext } from "../../providers/types";
import { ServiceError } from "../../services/errors";
import {
  canAccessWorkspace,
  canManageWorkspace,
} from "./authorization-service";

/**
 * The guard in front of every workspace MANAGE action (PATCH/DELETE
 * `/workspaces/:id`, the access routes):
 *
 * 1. A workspace-scoped API key is confined to its own workspace: naming a
 *    sibling is a 404 before any database read, so a leaked key cannot
 *    manage the rest of the org. Org keys and sessions are never confined.
 * 2. The workspace must sit in the CALLER'S CURRENT org context
 *    (`authCtx.organizationId`), not merely an org the caller happens to
 *    belong to (api-ee-behaviour §2.2: "404 if not in the caller's org").
 *    `canManageWorkspace`/`canAccessWorkspace` resolve the workspace's REAL
 *    org internally and don't consult `authCtx.organizationId` at all, so
 *    without this check a user who is a member of org A and an admin of org
 *    B could act on an org-B workspace while scoped (an org key, or a
 *    session's `x-organization-id`) to org A.
 * 3. A manager passes (access is not consulted).
 * 4. Someone who can only USE the workspace (shared in) gets a 403.
 * 5. Anyone else gets a 404 — existence is never leaked.
 */
export const requireWorkspaceManagement = async (
  authCtx: AuthContext,
  targetId: string,
): Promise<void> => {
  if (authCtx.scope === "workspace" && authCtx.workspaceId !== targetId) {
    throw new ServiceError("NOT_FOUND", "Workspace not found");
  }

  const workspace = await db.workspace.findUnique({
    where: { id: targetId },
    select: { organizationId: true },
  });
  if (!workspace || workspace.organizationId !== authCtx.organizationId) {
    throw new ServiceError("NOT_FOUND", "Workspace not found");
  }

  if (await canManageWorkspace(authCtx.userId, targetId)) return;
  if (await canAccessWorkspace(authCtx.userId, targetId)) {
    throw new ServiceError(
      "FORBIDDEN",
      "You don't have permission to manage this workspace",
    );
  }
  throw new ServiceError("NOT_FOUND", "Workspace not found");
};
