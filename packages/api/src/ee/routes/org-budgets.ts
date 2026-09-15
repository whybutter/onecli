import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../../types";
import type { AuthContext } from "../../providers";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import {
  listBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
  type BudgetListRow,
} from "../services/budget-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/org/budgets` — per-(secret, org) spend caps.
 *
 * Same guard stack as `/v1/org/policy`: admin-only, and an org-scope-credential
 * guard on top. Budgets are ORG guardrails — a workspace-scoped agent key (even
 * one whose user is an org admin) must not edit the cap its own traffic is
 * metered against. Org authority requires an org credential.
 *
 * `withAudit` keys `invalidateGatewayCacheForOrg` off `organizationId`, so a
 * new/changed cap takes effect within the connect cache TTL — do not flush
 * separately here.
 *
 * Metered types: `anthropic` and `openai` are both accepted at the API. The
 * gateway only meters Anthropic traffic as of Phase 1 — an OpenAI budget is
 * stored and returned here but not yet enforced; enforcement lands once the
 * gateway's OpenAI meter ships (fast-follow).
 */

/** Response row shape for GET/POST/PATCH — re-exported for the wire-shape diff. */
export type { BudgetListRow };

const periodSchema = z.enum(["monthly", "total"]);

const createBudgetSchema = z.object({
  secretId: z.string().min(1),
  limitCents: z.number().int().positive(),
  period: periodSchema.default("monthly"),
});

const updateBudgetSchema = z
  .object({
    limitCents: z.number().int().positive().optional(),
    period: periodSchema.optional(),
  })
  .refine((v) => v.limitCents !== undefined || v.period !== undefined, {
    message: "Provide limitCents and/or period.",
  });

const parse = <S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): z.infer<S> => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      result.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return result.data;
};

const jsonBody = (c: { req: { json: () => Promise<unknown> } }) =>
  c.req.json().catch(() => null);

export const orgBudgetRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireWorkspace: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "workspace") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization budgets require an organization-scoped credential.",
      );
    }
    return next();
  });

  const auditBase = (a: AuthContext) => ({
    organizationId: a.organizationId,
    userId: a.userId,
    userEmail: a.userEmail,
    service: AUDIT_SERVICES.BUDGET,
    source: AUDIT_SOURCE.API,
  });

  app.get("/", async (c) => {
    const { organizationId } = c.get("auth");
    return c.json(await listBudgets(organizationId));
  });

  app.post("/", async (c) => {
    const authCtx = c.get("auth");
    const input = parse(createBudgetSchema, await jsonBody(c));
    const budget = await withAudit(
      () => createBudget(authCtx.organizationId, input, authCtx.userId),
      (b) => ({
        ...auditBase(authCtx),
        action: AUDIT_ACTIONS.CREATE,
        metadata: {
          budgetId: b.id,
          secretId: b.secretId,
          limitCents: b.limitCents,
          period: b.period,
        },
      }),
    );
    return c.json(budget, 201);
  });

  app.patch("/:id", async (c) => {
    const authCtx = c.get("auth");
    const id = c.req.param("id");
    const input = parse(updateBudgetSchema, await jsonBody(c));
    const budget = await withAudit(
      () => updateBudget(authCtx.organizationId, id, input),
      (b) => ({
        ...auditBase(authCtx),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          budgetId: id,
          secretId: b.secretId,
          limitCents: b.limitCents,
          period: b.period,
        },
      }),
    );
    return c.json(budget);
  });

  app.delete("/:id", async (c) => {
    const authCtx = c.get("auth");
    const id = c.req.param("id");
    await withAudit(
      () => deleteBudget(authCtx.organizationId, id),
      (r) => ({
        ...auditBase(authCtx),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { budgetId: id, secretId: r.secretId },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
