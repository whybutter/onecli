import { db } from "@onecli/db";
import type { AuthContext } from "../../providers";
import { getRoleResolver, ROLE_HIERARCHY } from "../../providers";
import { recordApiKeyUse } from "../../services/api-key-service";
import { resolveUserEmail, canAccessWorkspaceAsUser } from "./resolve";

/**
 * API-key authentication result:
 *
 * - `AuthContext` — a valid key resolved its scope.
 * - `"missing-workspace"` — a *valid* org key (found + admin re-checked) hit a
 *   `requireWorkspace` route without an `X-Workspace-Id` header. Distinguished so
 *   strict mode can tell the caller to name a workspace — without misleading a
 *   revoked-key holder, and mirroring the gateway, whose header message also
 *   fires only after a successful key lookup.
 * - `"invalid-key"` — an `oc_` bearer was presented but failed authentication
 *   (unknown/revoked key, demoted holder, workspace outside the key's org, …).
 * - `null` — the request carried no `oc_` bearer at all (no header, another
 *   scheme, or a non-OneCLI token) — nothing here to authenticate.
 *
 * Non-strict callers treat both string sentinels exactly like `null` (fall
 * through to session auth); strict mode turns them into precise 401s.
 */
export type ApiKeyAuthResult =
  | AuthContext
  | "missing-workspace"
  | "invalid-key"
  | null;

export const authenticateApiKey = async (
  request: Request,
  requireWorkspace: boolean,
): Promise<ApiKeyAuthResult> => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !token.startsWith("oc_")) return null;

  // Org key (oc_org_*)
  if (token.startsWith("oc_org_")) {
    const apiKey = await db.apiKey.findUnique({
      where: { key: token },
      // `id`/`key`/`lastUsedAt` ride along for the usage write-back — the row
      // is already being read, so recency costs nothing extra here. `key`
      // pins the write to the secret that authenticated, so a concurrent
      // rotation cannot inherit this request's use.
      select: {
        id: true,
        key: true,
        userId: true,
        organizationId: true,
        scope: true,
        lastUsedAt: true,
      },
    });
    if (!apiKey || apiKey.scope !== "organization" || !apiKey.organizationId)
      return "invalid-key";

    // Org keys are an admin capability — re-check the key's user still holds
    // admin/owner in the org. Closes the gap where a key keeps working after
    // a demotion.
    const resolver = getRoleResolver();
    const role = resolver
      ? await resolver.getUserRole(apiKey.userId, apiKey.organizationId)
      : null;
    if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.admin)
      return "invalid-key";

    const userEmail = await resolveUserEmail(apiKey.userId);
    const headerWorkspaceId = request.headers.get("x-workspace-id");

    // Not a recorded use: the credential checked out, but the request never
    // resolved to a caller. `lastUsedAt` answers "did this key authenticate",
    // and only the AuthContext returns below are that.
    if (requireWorkspace && !headerWorkspaceId) return "missing-workspace";

    // Resolved once so the success path — and the usage write-back on it —
    // has a single exit. Unset stays `undefined` (an org-wide context), a
    // header naming a workspace outside the key's org is still "invalid-key".
    let scopedWorkspaceId: string | undefined;
    if (headerWorkspaceId) {
      const workspace = await db.workspace.findFirst({
        where: {
          id: headerWorkspaceId,
          organizationId: apiKey.organizationId,
        },
        select: { id: true },
      });
      if (!workspace) return "invalid-key";
      scopedWorkspaceId = workspace.id;
    }

    await recordApiKeyUse(apiKey);

    return {
      userId: apiKey.userId,
      userEmail,
      workspaceId: scopedWorkspaceId,
      organizationId: apiKey.organizationId,
      scope: "organization",
    };
  }

  // Workspace key (oc_*)
  const apiKey = await db.apiKey.findUnique({
    where: { key: token },
    select: {
      id: true,
      key: true,
      userId: true,
      workspaceId: true,
      kind: true,
      lastUsedAt: true,
    },
  });
  if (!apiKey || !apiKey.workspaceId) return "invalid-key";

  // Service keys (platform-minted, e.g. a channel presence's approvals key) are
  // scoped to their one machine purpose — the gateway's approvals API — and must
  // NOT authenticate the general /v1 surface. Without this, a leaked service key
  // could call POST /v1/agents/:id/regenerate-token and obtain the agent's proxy
  // credential — the very thing the gateway injects with. The narrow purpose is
  // the boundary; enforce it here where every /v1 route funnels through.
  if (apiKey.kind === "service") return "invalid-key";

  const workspace = await db.workspace.findUnique({
    where: { id: apiKey.workspaceId },
    select: { id: true, organizationId: true },
  });
  if (!workspace) return "invalid-key";

  // Re-check access at request time: the key authenticates only while its user
  // still has access to the workspace (org admin/owner, or a WorkspaceAccess binding
  // — the creator arm was dropped in step 13b). OSS is a no-op (single-user, no
  // role resolver). Mirrors resolveWorkspaceId.
  if (!(await canAccessWorkspaceAsUser(apiKey.userId, workspace)))
    return "invalid-key";

  const userEmail = await resolveUserEmail(apiKey.userId);

  await recordApiKeyUse(apiKey);

  return {
    userId: apiKey.userId,
    userEmail,
    workspaceId: apiKey.workspaceId,
    organizationId: workspace.organizationId,
    scope: "workspace",
  };
};
