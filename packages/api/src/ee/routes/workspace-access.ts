import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";
import { requireWorkspaceManagement } from "../services/workspace-management-guard";
import {
  getWorkspaceAccessBindings,
  setWorkspaceAccessBindings,
  type SetWorkspaceAccessResult,
  type WorkspaceAccessBindings,
} from "../services/workspace-access-service";
import { setWorkspaceAccessSchema } from "../validations/directory";

export type { SetWorkspaceAccessResult, WorkspaceAccessBindings };

/**
 * `/workspaces/:workspaceId/access` — the workspace's human-sharing surface
 * (api-ee-behaviour §2.2). Composed onto the free `workspaceRoutes()` base
 * path from `ee/index.ts`. Read auth only; both routes additionally run
 * `requireWorkspaceManagement` in-handler — a shared-in (use-only) member
 * gets 403, a stranger or cross-org id gets 404, and a workspace-scoped key
 * naming a sibling workspace is confined to 404 before any DB read.
 */
export const workspaceAccessRoutes = () => {
  const app = new Hono<ApiEnv>();
  const read = auth({ requireWorkspace: false });

  app.get("/:workspaceId/access", read, async (c) => {
    const authCtx = c.get("auth");
    const workspaceId = c.req.param("workspaceId");
    await requireWorkspaceManagement(authCtx, workspaceId);
    return c.json(await getWorkspaceAccessBindings(workspaceId));
  });

  app.put("/:workspaceId/access", read, async (c) => {
    const authCtx = c.get("auth");
    const workspaceId = c.req.param("workspaceId");
    await requireWorkspaceManagement(authCtx, workspaceId);

    const body = await c.req.json().catch(() => null);
    const parsed = setWorkspaceAccessSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const result = await withAudit(
      () =>
        setWorkspaceAccessBindings(
          authCtx.organizationId,
          workspaceId,
          authCtx.userId,
          parsed.data,
        ),
      (delta) => ({
        // Scoped by workspaceId, deliberately NOT organizationId — §2.2.
        workspaceId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.WORKSPACE,
        source: AUDIT_SOURCE.API,
        metadata: {
          added: delta.added,
          removed: delta.removed,
          roleChanged: delta.roleChanged,
        },
      }),
    );
    return c.json(result);
  });

  return app;
};
