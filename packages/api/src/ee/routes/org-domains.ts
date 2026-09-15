import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import {
  withAudit,
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  claimOrgDomain,
  deleteOrgDomain,
  listOrgDomains,
  verifyOrgDomain,
  type OrgDomainRow,
} from "../services/org-domain-service";
import { claimDomainSchema } from "../validations/directory";

export type { OrgDomainRow };

/**
 * `/org/domains` — the organization's claimed email domains
 * (api-ee-behaviour §8.1). Admin auth on every route. GET and DELETE are
 * never plan-gated (a locked page still renders, and teardown must survive a
 * plan lapse); POST and the verify route call `assertFeatureAllowed(org,
 * "sso")` (a no-op in this build).
 */
export const orgDomainRoutes = () => {
  const app = new Hono<ApiEnv>();
  const admin = auth({ requireWorkspace: false, role: "admin" });
  app.use("*", admin);
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "workspace") {
      throw new ServiceError(
        "FORBIDDEN",
        "Domains require an organization-scoped credential.",
      );
    }
    return next();
  });

  const auditBase = (c: Context<ApiEnv>) => ({
    organizationId: c.get("auth").organizationId,
    userId: c.get("auth").userId,
    userEmail: c.get("auth").userEmail,
    service: AUDIT_SERVICES.DOMAIN,
    source: AUDIT_SOURCE.API,
  });

  // GET /org/domains
  app.get("/", async (c) => {
    const authCtx = c.get("auth");
    return c.json(await listOrgDomains(authCtx.organizationId));
  });

  // POST /org/domains
  app.post("/", async (c) => {
    const authCtx = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = claimDomainSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    await assertFeatureAllowed(authCtx.organizationId, "sso");

    const domain = await withAudit(
      () =>
        claimOrgDomain(
          authCtx.organizationId,
          authCtx.userId,
          parsed.data.domain,
        ),
      (created) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.CREATE,
        metadata: { domainId: created.id, domain: created.domain },
      }),
    );
    return c.json(domain, 201);
  });

  // POST /org/domains/:domainId/verify — a real DNS miss throws before any
  // audit; `withAudit` always logs, so it doesn't fit here — only a REAL
  // unverified→verified transition is a VERIFY event. A re-check of an
  // already-verified row is a read (`changed: false`) and must not write N
  // audit rows for a double-click or a polling client.
  app.post("/:domainId/verify", async (c) => {
    const authCtx = c.get("auth");
    const domainId = c.req.param("domainId");
    await assertFeatureAllowed(authCtx.organizationId, "sso");

    const { domain, changed } = await verifyOrgDomain(
      authCtx.organizationId,
      domainId,
    );
    if (changed) {
      await recordAuditEvent({
        ...auditBase(c),
        action: AUDIT_ACTIONS.VERIFY,
        metadata: {
          domainId: domain.id,
          domain: domain.domain,
          verified: true,
        },
      });
    }
    return c.json(domain);
  });

  // DELETE /org/domains/:domainId
  app.delete("/:domainId", async (c) => {
    const authCtx = c.get("auth");
    const domainId = c.req.param("domainId");

    await withAudit(
      () => deleteOrgDomain(authCtx.organizationId, domainId),
      () => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { domainId },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
