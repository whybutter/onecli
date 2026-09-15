import { Hono } from "hono";
import type { Context } from "hono";
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
  addOrgGroupMember,
  createOrgGroup,
  deleteOrgGroup,
  getOrgGroup,
  listOrgGroupMembers,
  listOrgGroups,
  removeOrgGroupMember,
  renameOrgGroup,
  setOrgGroupMembers,
  type GroupMemberRow,
  type GroupRow,
} from "../services/group-service";
import type { DirectoryPage } from "../lib/directory-page";
import {
  createGroupSchema,
  directoryListQuerySchema,
  groupListQuerySchema,
  renameGroupSchema,
  setGroupMembersSchema,
} from "../validations/directory";

export type { GroupRow, GroupMemberRow, DirectoryPage };

/**
 * `/org/groups` — the organization's human-group directory
 * (api-ee-behaviour §4.2). Admin auth on every route; writes additionally
 * run `assertFeatureAllowed(org, "groups")` (a no-op in this build — see
 * `quota-service.ts` — kept so the call site matches the spec and survives a
 * future entitlement layer unchanged). Reads are never plan-gated.
 */
export const orgGroupRoutes = () => {
  const app = new Hono<ApiEnv>();
  const admin = auth({ requireWorkspace: false, role: "admin" });
  app.use("*", admin);

  const auditBase = (c: Context<ApiEnv>) => ({
    organizationId: c.get("auth").organizationId,
    userId: c.get("auth").userId,
    userEmail: c.get("auth").userEmail,
    service: AUDIT_SERVICES.GROUP,
    source: AUDIT_SOURCE.API,
  });

  // GET /org/groups
  app.get("/", async (c) => {
    const authCtx = c.get("auth");
    const parsed = groupListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(await listOrgGroups(authCtx.organizationId, parsed.data));
  });

  // POST /org/groups
  app.post("/", async (c) => {
    const authCtx = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createGroupSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    const group = await withAudit(
      () => createOrgGroup(authCtx.organizationId, parsed.data.name),
      (created) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.CREATE,
        metadata: { groupId: created.id, name: created.name },
      }),
    );
    return c.json(group, 201);
  });

  // GET /org/groups/:groupId
  app.get("/:groupId", async (c) => {
    const authCtx = c.get("auth");
    return c.json(
      await getOrgGroup(authCtx.organizationId, c.req.param("groupId")),
    );
  });

  // PATCH /org/groups/:groupId — rename.
  app.patch("/:groupId", async (c) => {
    const authCtx = c.get("auth");
    const groupId = c.req.param("groupId");
    const body = await c.req.json().catch(() => null);
    const parsed = renameGroupSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    const group = await withAudit(
      () => renameOrgGroup(authCtx.organizationId, groupId, parsed.data.name),
      (renamed) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { groupId: renamed.id, name: renamed.name },
      }),
    );
    return c.json(group);
  });

  // DELETE /org/groups/:groupId
  app.delete("/:groupId", async (c) => {
    const authCtx = c.get("auth");
    const groupId = c.req.param("groupId");
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    await withAudit(
      () => deleteOrgGroup(authCtx.organizationId, groupId),
      (deleted) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { groupId: deleted.id, name: deleted.name },
      }),
    );
    return c.body(null, 204);
  });

  // GET /org/groups/:groupId/members
  app.get("/:groupId/members", async (c) => {
    const authCtx = c.get("auth");
    const groupId = c.req.param("groupId");
    const parsed = directoryListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(
      await listOrgGroupMembers(authCtx.organizationId, groupId, parsed.data),
    );
  });

  // PUT /org/groups/:groupId/members — full replace-set.
  app.put("/:groupId/members", async (c) => {
    const authCtx = c.get("auth");
    const groupId = c.req.param("groupId");
    const body = await c.req.json().catch(() => null);
    const parsed = setGroupMembersSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    const result = await withAudit(
      () =>
        setOrgGroupMembers(
          authCtx.organizationId,
          authCtx.userId,
          groupId,
          parsed.data.userIds,
        ),
      (delta) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { groupId, added: delta.added, removed: delta.removed },
      }),
    );
    return c.json(result);
  });

  // PUT /org/groups/:groupId/members/:userId — idempotent single add.
  app.put("/:groupId/members/:userId", async (c) => {
    const authCtx = c.get("auth");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    await withAudit(
      () =>
        addOrgGroupMember(
          authCtx.organizationId,
          authCtx.userId,
          groupId,
          userId,
        ),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { groupId, targetUserId: userId, added: r.added },
      }),
    );
    return c.body(null, 204);
  });

  // DELETE /org/groups/:groupId/members/:userId — idempotent single remove.
  app.delete("/:groupId/members/:userId", async (c) => {
    const authCtx = c.get("auth");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    await withAudit(
      () => removeOrgGroupMember(authCtx.organizationId, groupId, userId),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { groupId, targetUserId: userId, removed: r.removed },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
