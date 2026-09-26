import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { listRunners } from "../services/runner-service";

/**
 * GET /v1/runners — the operator's view of the compute plane: which runners
 * exist and whether they are alive. Read-only; runners are created by
 * registering (§5.1), never through this surface.
 *
 * Deployment-scoped rather than workspace-scoped (one runner serves the whole
 * install in v2), which is exactly why it is **admin-only**: names are
 * operator-chosen and usually hostnames, and `sandboxCount` is a
 * deployment-wide total, so on a multi-org install an ordinary member of one
 * org would otherwise learn about every other org's fleet usage. The people
 * who need this are the people who can restart the runner.
 *
 * It carries no workspace, agent, or credential detail either way — the token
 * column is never even selected.
 */
export const runnersRoutes = () => {
  const app = new Hono<ApiEnv>();

  const guard = auth({ requireWorkspace: false, role: "admin" });

  app.get("/", guard, async (c) => c.json({ runners: await listRunners() }));

  return app;
};
