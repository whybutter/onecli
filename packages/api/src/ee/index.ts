import type { Hono } from "hono";
import type { ApiEnv } from "../types";
import { orgUsageRoutes } from "./routes/org-usage";
import { agentDefaultsRoutes } from "./routes/agent-defaults";

export type RegisterEeRoutes = (app: Hono<ApiEnv>) => void;

/**
 * Enterprise route registration, mounted under `/v1` by `createApiApp`.
 *
 * Phase 0 of the v2 migration mounted nothing: every router the licensed tree
 * used to add here (org members, groups, domains, workspace access, …) is
 * rebuilt across Phase 2's work packages. One `app.route(...)` line per
 * router, alphabetical by prefix.
 */
export const registerEeRoutes: RegisterEeRoutes = (app) => {
  app.route("/org/usage", orgUsageRoutes());
  app.route("/workspaces/:workspaceId/agent-defaults", agentDefaultsRoutes());
};
