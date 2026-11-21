import { createServer, type Server } from "node:http";
import { describe, expect } from "vitest";

import { grantSecret } from "../src/fixtures.js";
import { throughMitm } from "../src/mitm.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * A re-pair or disconnect must invalidate the vault session and the cached
 * credential in the fork's single gateway. A separate two-process scenario
 * checks database-backed revocation after the second gateway's local cache
 * is explicitly invalidated.
 *
 * 1Password is the provider driven here because its vendor surface is the
 * gateway's own internal HTTP hop (`INTERNAL_API_URL`), which a stub can
 * answer. Bitwarden needs a live relay and a paired desktop app; its session
 * lifecycle is covered by the vault crate's Postgres tests.
 */

const OP_REF = "op://E2E/Item/credential";
const HEADER = "x-test-key";

/** The value the stub resolves for a given service-account token. Distinct per
 * token, so an injected header names the token that produced it. */
const valueFor = (token: string): string => `resolved-with-${token}`;

interface StubOnePassword {
  readonly url: string;
  /** Every token the gateways resolved a reference with, in arrival order. */
  readonly resolvedWith: string[];
  close(): Promise<void>;
}

/** The `token` a 1Password-service request carries, or `""` when the body is
 * missing or malformed. Narrowed by inspection, never by assertion. */
const tokenOf = (raw: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null || !("token" in parsed)) {
    return "";
  }
  return typeof parsed.token === "string" ? parsed.token : "";
};

/** Stands in for the api's internal 1Password SDK service: validates any
 * token and resolves every reference to a value derived from the token. */
const startStubOnePassword = (): Promise<StubOnePassword> =>
  new Promise((resolve, reject) => {
    const resolvedWith: string[] = [];
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (raw += chunk));
      req.on("end", () => {
        const token = tokenOf(raw);
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/internal/onepassword/validate") {
          res.end(JSON.stringify({ valid: true }));
          return;
        }
        if (req.url === "/v1/internal/onepassword/resolve") {
          resolvedWith.push(token);
          res.end(JSON.stringify({ value: valueFor(token) }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "not stubbed" } }));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("1Password stub: no TCP address after listen"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        resolvedWith,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });

/** A workspace secret whose value is a live 1Password reference, attached to
 * the main agent. */
const seedOnePasswordSecret = async (cx: Cx): Promise<void> => {
  const id = `${cx.ids.workspace}-sec-op`;
  await cx.db.prisma.secret.create({
    data: {
      id,
      name: id,
      type: "generic",
      scope: "workspace",
      workspaceId: cx.ids.workspace,
      organizationId: cx.ids.org,
      valueSource: "onepassword",
      opRef: OP_REF,
      encryptedValue: null,
      hostPattern: "127.0.0.1",
      injectionConfig: { headerName: HEADER },
    },
  });
  await grantSecret(cx.db.prisma, cx.ids, id);
};

const vaultCall = (
  gatewayOrigin: string,
  apiKey: string,
  method: "POST" | "DELETE",
  body?: Record<string, string>,
): Promise<Response> =>
  fetch(`${gatewayOrigin}/v1/vault/onepassword/pair`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("vault revocation", () => {
  const startGateway = (cx: Cx, stub: StubOnePassword) =>
    cx.startGateway({
      env: {
        INTERNAL_API_URL: stub.url,
        GATEWAY_INTERNAL_SECRET: "e2e-internal-secret",
        REDIS_HOST: "",
      },
    });

  scenario("re-pair replaces an already cached credential", async (cx) => {
    const stub = await startStubOnePassword();
    try {
      const upstream = await cx.upstreamTls();
      await cx.seed({ withApiKey: true });
      await seedOnePasswordSecret(cx);
      const gw = await startGateway(cx, stub);
      const throughGateway = () =>
        throughMitm(gw.origin, {
          authority: upstream.authority,
          path: "/v1/models",
          token: cx.ids.agentToken,
          caPath: gw.caPath,
        });

      // 1. Pair, then warm the gateway cache with a request.
      expect(
        (
          await vaultCall(gw.origin, cx.ids.apiKey, "POST", {
            service_account_token: "token-one",
          })
        ).status,
      ).toBe(200);
      expect((await throughGateway()).status).toBe(200);
      const [first] = await upstream.waitForRequests(1);
      expect(first?.header(HEADER)).toBe(valueFor("token-one"));

      // 2. Re-pair with a different token. The gateway must stop using the
      //    token it already loaded and inject with the new one.
      expect(
        (
          await vaultCall(gw.origin, cx.ids.apiKey, "POST", {
            service_account_token: "token-two",
          })
        ).status,
      ).toBe(200);
      expect((await throughGateway()).status).toBe(200);
      const seen = await upstream.waitForRequests(2);
      expect(seen[1]?.header(HEADER)).toBe(valueFor("token-two"));
    } finally {
      await stub.close();
    }
  });

  scenario(
    "disconnect stops injection of an already cached credential",
    async (cx) => {
      const stub = await startStubOnePassword();
      try {
        const upstream = await cx.upstreamTls();
        await cx.seed({ withApiKey: true });
        await seedOnePasswordSecret(cx);
        const gw = await startGateway(cx, stub);
        const throughGateway = () =>
          throughMitm(gw.origin, {
            authority: upstream.authority,
            path: "/v1/models",
            token: cx.ids.agentToken,
            caPath: gw.caPath,
          });

        expect(
          (
            await vaultCall(gw.origin, cx.ids.apiKey, "POST", {
              service_account_token: "token-one",
            })
          ).status,
        ).toBe(200);
        expect((await throughGateway()).status).toBe(200);
        const [before] = await upstream.waitForRequests(1);
        expect(before?.header(HEADER)).toBe(valueFor("token-one"));

        // Disconnect after warming the session and connect caches;
        // the revoked token must not reach the upstream through it.
        expect(
          (await vaultCall(gw.origin, cx.ids.apiKey, "DELETE")).status,
        ).toBe(200);
        const resolvesAtDisconnect = stub.resolvedWith.length;

        expect((await throughGateway()).status).toBe(200);
        const seen = await upstream.waitForRequests(2);
        expect(seen[1]?.header(HEADER)).toBe(undefined);
        // And B never presented the revoked token to 1Password again.
        expect(stub.resolvedWith.slice(resolvesAtDisconnect)).toEqual([]);
      } finally {
        await stub.close();
      }
    },
  );

  // The revocation rides the shared database alone — no Redis. An unlicensed
  // self-host runs in-memory stores (HA is licensed), so each gateway's
  // connect cache is its own; only the row-generation check can carry a
  // disconnect across instances there.
  scenario(
    "a disconnect reaches the other gateway without Redis (unlicensed self-host)",
    async (cx) => {
      const stub = await startStubOnePassword();
      try {
        const upstream = await cx.upstreamTls();
        await cx.seed({ withApiKey: true });
        await seedOnePasswordSecret(cx);
        const a = await startGateway(cx, stub);
        const b = await startGateway(cx, stub);
        const throughB = () =>
          throughMitm(b.origin, {
            authority: upstream.authority,
            path: "/v1/models",
            token: cx.ids.agentToken,
            caPath: b.caPath,
          });

        expect(
          (
            await vaultCall(a.origin, cx.ids.apiKey, "POST", {
              service_account_token: "token-one",
            })
          ).status,
        ).toBe(200);
        expect((await throughB()).status).toBe(200);
        const [before] = await upstream.waitForRequests(1);
        expect(before?.header(HEADER)).toBe(valueFor("token-one"));

        expect(
          (await vaultCall(a.origin, cx.ids.apiKey, "DELETE")).status,
        ).toBe(200);
        // B's own in-memory connect cache still holds the resolution from
        // above — A's flush cannot reach it without a shared store. Bust it
        // through B the way the dashboard does after a credential change, so
        // what is asserted is B's VAULT session, not its connect cache.
        expect(
          (
            await fetch(`${b.origin}/v1/cache/invalidate`, {
              method: "POST",
              headers: { authorization: `Bearer ${cx.ids.apiKey}` },
            })
          ).status,
        ).toBe(200);
        const resolvesAtDisconnect = stub.resolvedWith.length;

        expect((await throughB()).status).toBe(200);
        const seen = await upstream.waitForRequests(2);
        expect(seen[1]?.header(HEADER)).toBe(undefined);
        expect(stub.resolvedWith.slice(resolvesAtDisconnect)).toEqual([]);
      } finally {
        await stub.close();
      }
    },
  );
});
