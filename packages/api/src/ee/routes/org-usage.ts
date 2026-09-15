import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { getOrganizationUsage, type UsageSummary } from "../services/usage-service";

/**
 * `/v1/org/usage` — recorded gateway request volume for the org, split by
 * agent.
 *
 * ## Why this router's guard stack differs from an admin-only `/v1/org/*`
 *
 * Members and directory/domain admin surfaces are `role: "admin"`. Usage is
 * deliberately NOT: it is **member-visible with per-workspace fencing**. The
 * fencing is not a second check bolted on — `getOrganizationUsage` scopes the
 * aggregate through `visibleWorkspacesWhere`, which returns only the
 * workspaces the caller may reach (org owner/admin: the whole org; a member:
 * their bound workspaces) — the same fence the workspace list applies. A
 * member with no bindings gets a zeroed summary, not a 403 (same shape as
 * `GET /workspaces`, whose list IS its authorization).
 *
 * The org-scope-credential guard is kept: this is an ORG-wide read, and a
 * workspace-scoped agent key must not be able to enumerate volume across
 * workspaces it was never issued for. Org breadth requires an org credential.
 *
 * Read-only — not audited (CLAUDE.md).
 */
export type OrgUsageResponse = UsageSummary;

const member = auth({ requireWorkspace: false, role: "member" });

export const orgUsageRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", member);
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "workspace") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization usage requires an organization-scoped credential.",
      );
    }
    return next();
  });

  app.get("/", async (c) => {
    const { organizationId, userId } = c.get("auth");
    const usage: OrgUsageResponse = await getOrganizationUsage(
      organizationId,
      userId,
    );
    return c.json(usage);
  });

  return app;
};
