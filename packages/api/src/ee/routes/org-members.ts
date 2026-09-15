import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  createMember,
  groupsFor,
  listMembersPage,
  reinstateMember,
  removeMember,
  setMemberSsoExempt,
  suspendMember,
  type OrgMemberListRow,
} from "../services/team-service";
import type { GroupRow } from "../services/group-service";
import type { DirectoryPage } from "../lib/directory-page";
import {
  createMemberSchema,
  memberListQuerySchema,
  memberPatchSchema,
  userGroupsQuerySchema,
} from "../validations/directory";

/** The wire shape a status/ssoExempt PATCH answers with (matches the
 * client's `OrgMemberRow`). */
export interface OrgMemberRow {
  userId: string;
  status: string;
  ssoExempt: boolean;
  revocation?: string;
}

export type { OrgMemberListRow, GroupRow, DirectoryPage };

const PATCH_ERROR =
  'Provide exactly one of { status: "active" | "suspended" } or { ssoExempt: boolean }';

/**
 * `/org/members` — the organization's membership directory
 * (api-ee-behaviour §1.2). Admin auth on every route; cross-org ids read as
 * 404 by construction (every service call is fenced on `auth.organizationId`).
 */
export const orgMemberRoutes = () => {
  const app = new Hono<ApiEnv>();
  const admin = auth({ requireWorkspace: false, role: "admin" });
  app.use("*", admin);
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "workspace") {
      throw new ServiceError(
        "FORBIDDEN",
        "Members require an organization-scoped credential.",
      );
    }
    return next();
  });

  const auditBase = (c: Context<ApiEnv>) => ({
    organizationId: c.get("auth").organizationId,
    userId: c.get("auth").userId,
    userEmail: c.get("auth").userEmail,
    service: AUDIT_SERVICES.MEMBER,
    source: AUDIT_SOURCE.API,
  });

  // GET /org/members
  app.get("/", async (c) => {
    const authCtx = c.get("auth");
    const parsed = memberListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(await listMembersPage(authCtx.organizationId, parsed.data));
  });

  // GET /org/members/:userId/groups
  app.get("/:userId/groups", async (c) => {
    const authCtx = c.get("auth");
    const targetUserId = c.req.param("userId");
    const parsed = userGroupsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(
      await groupsFor(authCtx.organizationId, targetUserId, parsed.data),
    );
  });

  // POST /org/members
  app.post("/", async (c) => {
    const authCtx = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createMemberSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    await assertFeatureAllowed(authCtx.organizationId, "sso");

    const created = await withAudit(
      () =>
        createMember(
          authCtx.organizationId,
          parsed.data.email,
          parsed.data.name ?? null,
        ),
      (member) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.CREATE,
        metadata: {
          targetUserId: member.userId,
          email: member.email,
          userCreated: member.userCreated,
        },
      }),
    );
    const response: OrgMemberListRow = {
      userId: created.userId,
      email: created.email,
      name: created.name,
      role: created.role,
      status: created.status,
      ssoExempt: created.ssoExempt,
      joinedAt: created.joinedAt,
    };
    return c.json(response, 201);
  });

  // DELETE /org/members/:userId — pre-checks (typed NOT_FOUND/BAD_REQUEST,
  // no audit row) live in `removeMember` itself, mirroring suspend/reinstate.
  app.delete("/:userId", async (c) => {
    const authCtx = c.get("auth");
    const targetUserId = c.req.param("userId");

    await withAudit(
      () =>
        removeMember(authCtx.organizationId, targetUserId, {
          revokeIdentity: true,
        }),
      (result) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.DELETE,
        metadata: {
          targetUserId,
          email: result.email,
          revocation: result.revocation,
        },
      }),
    );
    return c.body(null, 204);
  });

  // PATCH /org/members/:userId — exactly one of { status } | { ssoExempt }.
  app.patch("/:userId", async (c) => {
    const authCtx = c.get("auth");
    const targetUserId = c.req.param("userId");
    const body = await c.req.json().catch(() => null);
    const parsed = memberPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: PATCH_ERROR }, 400);
    }

    if ("status" in parsed.data) {
      const { status } = parsed.data;
      const result = await withAudit(
        () =>
          status === "suspended"
            ? suspendMember(
                authCtx.organizationId,
                targetUserId,
                authCtx.userId,
              )
            : reinstateMember(authCtx.organizationId, targetUserId),
        (updated) => ({
          ...auditBase(c),
          action: AUDIT_ACTIONS.UPDATE,
          metadata: {
            targetUserId,
            status: updated.status,
            revocation: updated.revocation,
          },
        }),
      );
      const response: OrgMemberRow = result;
      return c.json(response);
    }

    const { ssoExempt } = parsed.data;
    const result = await withAudit(
      () => setMemberSsoExempt(authCtx.organizationId, targetUserId, ssoExempt),
      (updated) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { targetUserId, ssoExempt: updated.ssoExempt },
      }),
    );
    const response: OrgMemberRow = result;
    return c.json(response);
  });

  return app;
};
