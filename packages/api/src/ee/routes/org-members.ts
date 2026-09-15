import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
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

/** The wire shape `POST /org/members` answers with. */
export interface CreatedOrgMemberRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  joinedAt: string;
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
    const response: CreatedOrgMemberRow = {
      userId: created.userId,
      email: created.email,
      name: created.name,
      role: created.role,
      status: created.status,
      joinedAt: created.joinedAt,
    };
    return c.json(response, 201);
  });

  // DELETE /org/members/:userId
  app.delete("/:userId", async (c) => {
    const authCtx = c.get("auth");
    const targetUserId = c.req.param("userId");

    // Pre-checks with typed errors, BEFORE any destructive step — matches
    // §1.4: cross-org ids read as absent, and the owner guard fires with no
    // audit row.
    const membership = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: authCtx.organizationId,
          userId: targetUserId,
        },
      },
      select: { role: true, userEmail: true },
    });
    if (!membership) {
      return c.json(
        { error: "User is not a member of this organization" },
        404,
      );
    }
    if (membership.role === "owner") {
      return c.json({ error: "The organization owner cannot be removed" }, 400);
    }

    await withAudit(
      () =>
        removeMember(authCtx.organizationId, targetUserId, {
          revokeIdentity: true,
        }),
      (revocation) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { targetUserId, email: membership.userEmail, revocation },
      }),
    );
    return c.body(null, 204);
  });

  // PATCH /org/members/:userId — exactly one of { status } | { ssoExempt }.
  app.patch("/:userId", async (c) => {
    const authCtx = c.get("auth");
    const targetUserId = c.req.param("userId");
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: PATCH_ERROR }, 400);
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1) return c.json({ error: PATCH_ERROR }, 400);

    if (keys[0] === "status") {
      if (record.status !== "active" && record.status !== "suspended") {
        return c.json({ error: PATCH_ERROR }, 400);
      }
      const status = record.status;
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

    if (keys[0] === "ssoExempt") {
      if (typeof record.ssoExempt !== "boolean") {
        return c.json({ error: PATCH_ERROR }, 400);
      }
      const ssoExempt = record.ssoExempt;
      const result = await withAudit(
        () =>
          setMemberSsoExempt(authCtx.organizationId, targetUserId, ssoExempt),
        (updated) => ({
          ...auditBase(c),
          action: AUDIT_ACTIONS.UPDATE,
          metadata: { targetUserId, ssoExempt: updated.ssoExempt },
        }),
      );
      const response: OrgMemberRow = result;
      return c.json(response);
    }

    return c.json({ error: PATCH_ERROR }, 400);
  });

  return app;
};
