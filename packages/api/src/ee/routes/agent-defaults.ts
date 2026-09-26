import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import type { AuthContext } from "../../providers";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";
import { connectionGrantSchema } from "../../validations/grants";
import {
  listWorkspaceAgentDefaults,
  removeWorkspaceAgentDefault,
  setWorkspaceAgentDefault,
  type WorkspaceAgentDefault,
} from "../services/agent-default-connections-service";
import type { GrantScope } from "../../services/grants-service";
import { requireWorkspaceManagement } from "../services/workspace-management-guard";

// The workspace-level "which connections should a brand-new agent start
// with" template (phase2-plan WP-B). Read by `afterCreateAgent` at
// agent-creation time; this router is the CRUD surface a human (or the
// settings UI) uses to configure it. Mirrors routes/grants.ts's shape one
// level up: workspace scope instead of agent scope, connections only.
//
// Mounted at /workspaces/:workspaceId/agent-defaults, behind
// requireWorkspaceManagement — the same MANAGE gate as PATCH/DELETE
// /workspaces/:id: an org owner/admin, or a direct workspace-access binding
// with role "owner". A caller who can only USE the workspace gets a 403; an
// unseen workspace (or a workspace-scoped key naming a sibling) is a 404.

export type AgentDefaultsResponse = WorkspaceAgentDefault[];

const read = auth({ requireWorkspace: false });

/**
 * The `:workspaceId` param lives on the MOUNT prefix (`ee/index.ts`'s
 * `app.route("/workspaces/:workspaceId/agent-defaults", ...)`), not on any
 * route this router declares itself, so Hono's per-instance typing can't see
 * it — `c.req.param` resolves it fine at runtime (the compiled route carries
 * the full merged path), this just recovers the static type.
 */
const requireWorkspaceIdParam = (c: {
  req: { param: (name: string) => string | undefined };
}): string => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    throw new ServiceError("NOT_FOUND", "Workspace not found");
  }
  return workspaceId;
};

const scopeOf = (auth: AuthContext, workspaceId: string): GrantScope => ({
  workspaceId,
  organizationId: auth.organizationId,
});

const auditBase = (auth: AuthContext, workspaceId: string) => ({
  workspaceId,
  userId: auth.userId,
  userEmail: auth.userEmail,
  service: AUDIT_SERVICES.GRANT,
  source: AUDIT_SOURCE.API,
});

export const agentDefaultsRoutes = () => {
  const app = new Hono<ApiEnv>();

  // GET /workspaces/:workspaceId/agent-defaults — the workspace's current
  // template (read-only, no audit).
  app.get("/", read, async (c) => {
    const authCtx = c.get("auth");
    const workspaceId = requireWorkspaceIdParam(c);
    await requireWorkspaceManagement(authCtx, workspaceId);
    const response: AgentDefaultsResponse = await listWorkspaceAgentDefaults(
      scopeOf(authCtx, workspaceId),
    );
    return c.json(response);
  });

  // PUT /workspaces/:workspaceId/agent-defaults/connections/:connectionId —
  // set or replace.
  app.put("/connections/:connectionId", read, async (c) => {
    const authCtx = c.get("auth");
    const workspaceId = requireWorkspaceIdParam(c);
    await requireWorkspaceManagement(authCtx, workspaceId);
    const connectionId = c.req.param("connectionId");
    const body = await c.req.json().catch(() => null);
    const parsed = connectionGrantSchema.safeParse(body);
    if (!parsed.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        parsed.error.issues[0]?.message ?? "Invalid default body",
      );
    }
    await withAudit(
      () =>
        setWorkspaceAgentDefault(
          scopeOf(authCtx, workspaceId),
          connectionId,
          parsed.data,
          authCtx.userId,
        ),
      () => ({
        ...auditBase(authCtx, workspaceId),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          connectionId,
          access: parsed.data.access,
          target: "agent-default",
        },
      }),
    );
    const response: AgentDefaultsResponse = await listWorkspaceAgentDefaults(
      scopeOf(authCtx, workspaceId),
    );
    return c.json(response);
  });

  // DELETE /workspaces/:workspaceId/agent-defaults/connections/:connectionId
  // — remove from the template.
  app.delete("/connections/:connectionId", read, async (c) => {
    const authCtx = c.get("auth");
    const workspaceId = requireWorkspaceIdParam(c);
    await requireWorkspaceManagement(authCtx, workspaceId);
    const connectionId = c.req.param("connectionId");
    await withAudit(
      () =>
        removeWorkspaceAgentDefault(
          scopeOf(authCtx, workspaceId),
          connectionId,
        ),
      () => ({
        ...auditBase(authCtx, workspaceId),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { connectionId, target: "agent-default" },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
