import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import { renameOrganization } from "../ee/services/organization-service";
import { renameOrganizationSchema } from "../validations/org";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

// The current organization, resolved from the membership-fenced auth context —
// never from input, so cross-org reads are impossible by construction.
// `role: "member"` runs the active-membership re-fence for API keys (a departed
// member's key must not keep reading org facts). Middleware is per-handler on
// purpose: this router mounts at /org, and Hono's route() copies a `use("*")`
// onto the parent as /org/*, which would impose this auth on every other
// /v1/org/... router.
const member = auth({ requireWorkspace: false, role: "member" });

// Rename is owner-only (api-ee-behaviour §3.3) — a stricter gate than the
// read above, so it gets its own middleware rather than reusing `member`.
const owner = auth({ requireWorkspace: false, role: "owner" });

export const orgRoutes = () => {
  const app = new Hono<ApiEnv>();

  // GET /v1/org — the org object plus its creation-world posture. `byoLegacy`
  // is the manually-operated per-org switch (sandbox-platform §3.10 as
  // re-decided 2026-08-23): on cloud, false = hosted-first creation, true =
  // BYO-only creation. `byoEnabled` (mixed world, 2026-08-29) is only read
  // when `byoLegacy` is false: it additionally allows BYO creation beside the
  // hosted default. Both inert on self-host — the web ignores them there.
  app.get("/", member, async (c) => {
    const authCtx = c.get("auth");
    const org = await db.organization.findUnique({
      where: { id: authCtx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        byoLegacy: true,
        byoEnabled: true,
      },
    });
    if (!org) {
      throw new ServiceError("NOT_FOUND", "Organization not found");
    }
    return c.json(org);
  });

  // PATCH /v1/org — rename (name only; `slug` is immutable). Owner-only:
  // `role: "owner"` above already 403s anyone below that threshold, so the
  // service's own re-check is defense-in-depth for a direct caller, not the
  // primary gate.
  app.patch("/", owner, async (c) => {
    const authCtx = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = renameOrganizationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const organization = await withAudit(
      () =>
        renameOrganization(
          authCtx.organizationId,
          authCtx.userId,
          parsed.data.name,
        ),
      (renamed) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        service: AUDIT_SERVICES.ORGANIZATION,
        source: AUDIT_SOURCE.API,
        action: AUDIT_ACTIONS.UPDATE,
        // `organizationId` is duplicated into the metadata deliberately: the
        // column scopes the row, the metadata records what the change was
        // ABOUT, and a log reader filtering on one should not have to know
        // about the other.
        metadata: {
          organizationId: authCtx.organizationId,
          change: "name",
          name: renamed.name,
        },
      }),
    );
    return c.json(organization);
  });

  return app;
};
