import { describe, expect } from "vitest";

import { scenario } from "../src/scenario.js";

/**
 * The RBAC role-recheck seam (`ee::rbac`, `gateway-ee-behaviour.md` §3):
 * every `oc_` bearer re-verifies its role on EVERY request, not just at
 * mint time. An org key (`oc_org_*`) must still be admin/owner; a
 * workspace key (`oc_*`) must still hold workspace access — directly, via
 * a group, or through an org admin/owner role. Any failure is the same
 * uniform 401 "invalid API key" the free liveness gate already produces
 * (`gateway-ee-behaviour.md` §3.3), so these tests assert on status codes,
 * never on a distinguishing error body.
 */

const invalidateWorkspaceCache = (
  origin: string,
  apiKey: string,
): Promise<Response> =>
  fetch(`${origin}/v1/cache/invalidate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
  });

const pendingOrgApprovals = (
  origin: string,
  orgApiKey: string,
): Promise<Response> =>
  fetch(`${origin}/v1/org/approvals/pending`, {
    headers: { authorization: `Bearer ${orgApiKey}` },
  });

describe("org key admin recheck", () => {
  scenario("denies a demoted (member) org key", async (cx) => {
    await cx.seed({ withOrgApiKey: true, orgApiKeyRole: "member" });
    const gw = await cx.startGateway();

    const res = await pendingOrgApprovals(gw.origin, cx.ids.orgApiKey);

    // A plain member's org key fails the `user_is_org_admin` recheck —
    // the uniform 401, same as an unknown key.
    expect(res.status).toBe(401);
  });

  scenario("allows an owner org key", async (cx) => {
    await cx.seed({ withOrgApiKey: true, orgApiKeyRole: "owner" });
    const gw = await cx.startGateway();

    const res = await pendingOrgApprovals(gw.origin, cx.ids.orgApiKey);

    expect(res.status).toBe(200);
  });

  scenario("allows an admin org key", async (cx) => {
    await cx.seed({ withOrgApiKey: true, orgApiKeyRole: "admin" });
    const gw = await cx.startGateway();

    const res = await pendingOrgApprovals(gw.origin, cx.ids.orgApiKey);

    expect(res.status).toBe(200);
  });
});

describe("workspace key access recheck", () => {
  scenario("allows a direct workspace_access binding", async (cx) => {
    await cx.seed({
      withApiKey: true,
      apiKeyMembership: { role: "member", workspaceBinding: "direct" },
    });
    const gw = await cx.startGateway();

    const res = await invalidateWorkspaceCache(gw.origin, cx.ids.apiKey);

    expect(res.status).toBe(200);
  });

  scenario("allows a group workspace_access binding", async (cx) => {
    await cx.seed({
      withApiKey: true,
      apiKeyMembership: { role: "member", workspaceBinding: "group" },
    });
    const gw = await cx.startGateway();

    const res = await invalidateWorkspaceCache(gw.origin, cx.ids.apiKey);

    expect(res.status).toBe(200);
  });

  scenario("denies a plain member with no binding", async (cx) => {
    await cx.seed({
      withApiKey: true,
      apiKeyMembership: { role: "member", workspaceBinding: "none" },
    });
    const gw = await cx.startGateway();

    const res = await invalidateWorkspaceCache(gw.origin, cx.ids.apiKey);

    // Active, but neither an org admin/owner nor bound to the workspace —
    // the recheck's plain-denial arm.
    expect(res.status).toBe(401);
  });

  scenario("denies a suspended member even with a binding", async (cx) => {
    await cx.seed({
      withApiKey: true,
      apiKeyMembership: {
        role: "member",
        status: "suspended",
        workspaceBinding: "direct",
      },
    });
    const gw = await cx.startGateway();

    const res = await invalidateWorkspaceCache(gw.origin, cx.ids.apiKey);

    // The free LIVENESS gate (`user_can_access_workspace`) already denies a
    // suspended member before the ee role recheck ever runs — suspension
    // beats binding either way.
    expect(res.status).toBe(401);
  });
});
