import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * Budgets end to end: a `budgets` row caps spend on a secret, the gateway
 * blocks once the cap is reached (`gateway-ee-behaviour.md` §4.4:
 * `is_over_budget` is `>=`, inclusive), and a metered Anthropic response's
 * usage is priced and recorded into `budget_spends` off the request path
 * (the telemetry flush).
 *
 * `fixtures.ts` (WP-A's) has no budget vocabulary, so these tests write
 * `Budget`/`BudgetSpend` rows directly via `cx.db.prisma` rather than
 * extending it. Secret ids seeded by `seedWorld` follow the fixture's own
 * scheme, `${ids.workspace}-sec-${index}` (see `addSecret` in
 * `src/fixtures.ts`) — the first (and only) secret seeded below is therefore
 * `${ids.workspace}-sec-0`.
 */

/** Poll `budget_spends` until a row appears — the flush is near-immediate
 * once an event is queued (`telemetry::core::collect_batch` returns as soon
 * as the first event arrives), but still off the request path. */
const waitForRecordedSpend = async (
  cx: Cx,
  secretId: string,
  subject: string,
  period: string,
  timeoutMs = 10_000,
): Promise<bigint> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await cx.db.prisma.budgetSpend.findUnique({
      where: {
        secretId_organizationId_period: {
          secretId,
          organizationId: subject,
          period,
        },
      },
    });
    if (row !== null && row.spentNanos > 0n) return row.spentNanos;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `no recorded spend for ${secretId}/${subject}/${period} within ${String(timeoutMs)}ms`,
  );
};

describe("budgets", () => {
  scenario(
    "spend seeded exactly at the limit blocks with budget_exceeded",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed({
        grantAll: true,
        secrets: [
          {
            type: "anthropic",
            hostPattern: "127.0.0.1",
            value: "sk-e2e-budget",
          },
        ],
      });
      const secretId = `${cx.ids.workspace}-sec-0`;
      const subject = `org:${cx.ids.org}`;
      const limitCents = 500; // $5.00

      await cx.db.prisma.budget.create({
        data: {
          id: `${cx.ids.workspace}-budget`,
          secretId,
          organizationId: cx.ids.org,
          limitCents,
          period: "total",
          createdBy: cx.ids.user,
        },
      });
      // Exactly at the limit: limitCents * 1e7 nanos/cent.
      await cx.db.prisma.budgetSpend.create({
        data: {
          secretId,
          organizationId: subject,
          period: "total",
          spentNanos: BigInt(limitCents) * 10_000_000n,
        },
      });

      const gw = await cx.startGateway();
      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: "budget_exceeded" });
      expect(res.header("x-should-retry")).toBe("false");
      // Blocked before forwarding — the stub must never see the request.
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "under budget forwards the request and records metered spend",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed({
        grantAll: true,
        secrets: [
          {
            type: "anthropic",
            hostPattern: "127.0.0.1",
            value: "sk-e2e-budget",
          },
        ],
      });
      const secretId = `${cx.ids.workspace}-sec-0`;
      const subject = `org:${cx.ids.org}`;

      await cx.db.prisma.budget.create({
        data: {
          id: `${cx.ids.workspace}-budget`,
          secretId,
          organizationId: cx.ids.org,
          limitCents: 100_000, // $1,000 — nowhere near what this request could spend.
          period: "total",
          createdBy: cx.ids.user,
        },
      });

      // A non-streaming Anthropic response the JSON accumulator can price:
      // 1000 input + 100 output tokens on opus = 7,500,000 nanos.
      upstream.respond({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "msg_e2e",
          model: "claude-opus-4-1-20250805",
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
      });

      const gw = await cx.startGateway();
      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/messages"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(200);
      await upstream.waitForRequests(1);

      const spentNanos = await waitForRecordedSpend(
        cx,
        secretId,
        subject,
        "total",
      );
      expect(spentNanos).toBe(7_500_000n);
    },
  );
});
