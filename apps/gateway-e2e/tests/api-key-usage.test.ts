import { describe, expect } from "vitest";

import { scenario } from "../src/scenario.js";

/**
 * The gateway-side `api_keys.last_used_at` stamp (phase2-plan Risk 8 — the
 * integration-step follow-up now that Phase 2's migration has landed the
 * column). A key that authenticates SUCCESSFULLY at the gateway — after
 * liveness AND the role recheck both pass, not merely after the row lookup —
 * gets a throttled stamp pinned to the key value. Mirrors the API's
 * `recordApiKeyUse` (`packages/api/src/services/api-key-service.ts`), which
 * the gateway's throttle window is kept in lockstep with.
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

describe("api_keys.last_used_at stamp", () => {
  scenario(
    "stamps last_used_at after an authenticated control-route call",
    async (cx) => {
      await cx.seed({ withApiKey: true });
      const gw = await cx.startGateway();

      const res = await invalidateWorkspaceCache(gw.origin, cx.ids.apiKey);
      expect(res.status).toBe(200);

      const key = await cx.db.prisma.apiKey.findUnique({
        where: { key: cx.ids.apiKey },
        select: { lastUsedAt: true },
      });
      expect(key?.lastUsedAt).not.toBeNull();
    },
  );

  scenario(
    "does not stamp last_used_at when authentication fails",
    async (cx) => {
      // A plain member with no workspace binding fails the role recheck —
      // the row must read exactly as unused as it did before the request.
      await cx.seed({
        withApiKey: true,
        apiKeyMembership: { role: "member", workspaceBinding: "none" },
      });
      const gw = await cx.startGateway();

      const res = await invalidateWorkspaceCache(gw.origin, cx.ids.apiKey);
      expect(res.status).toBe(401);

      const key = await cx.db.prisma.apiKey.findUnique({
        where: { key: cx.ids.apiKey },
        select: { lastUsedAt: true },
      });
      expect(key?.lastUsedAt).toBeNull();
    },
  );
});
