import type { Hono } from "hono";
import type { ApiEnv } from "../types";
import { agentDefaultsRoutes } from "./routes/agent-defaults";
import { orgBudgetRoutes } from "./routes/org-budgets";
import { orgDomainRoutes } from "./routes/org-domains";
import { orgGroupRoutes } from "./routes/org-groups";
import { orgMemberRoutes } from "./routes/org-members";
import { orgUsageRoutes } from "./routes/org-usage";
import { workspaceAccessRoutes } from "./routes/workspace-access";

export type RegisterEeRoutes = (app: Hono<ApiEnv>) => void;

/**
 * Enterprise route registration, mounted under `/v1` by `createApiApp`.
 *
 * Phase 2 (WP-A) of the v2 migration starts populating this: the RBAC
 * directory surface (org members, groups, workspace access) and org domains.
 * One `app.route(...)` per line, alphabetical by prefix, so a textual merge
 * of the three work packages' insertions never conflicts. There is no
 * `requireEnterprise` middleware in this fork (unlike the licensed tree —
 * see `phase2-plan.md` correction 4): every route here answers unconditionally,
 * gated only by the auth middleware's `role` option and, where the spec
 * calls for it, the no-op `assertFeatureAllowed`/`assertCanShareWorkspace`
 * seams in `quota-service.ts`.
 */
export const registerEeRoutes: RegisterEeRoutes = (app) => {
  app.route("/org/budgets", orgBudgetRoutes());
  app.route("/org/domains", orgDomainRoutes());
  app.route("/org/groups", orgGroupRoutes());
  app.route("/org/members", orgMemberRoutes());
  app.route("/org/usage", orgUsageRoutes());
  // Composes onto the free `workspaceRoutes()` base path — GET/PUT
  // `/workspaces/:id/access` — rather than owning `/workspaces` itself.
  app.route("/workspaces", workspaceAccessRoutes());
  app.route("/workspaces/:workspaceId/agent-defaults", agentDefaultsRoutes());
};
