import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";

import type { PrismaClient } from "@prisma/client";
import { describe, expect } from "vitest";

import type { GatewayHandle } from "../src/gateway.js";
import {
  generateCa,
  generateClientLeaf,
  generateServerCert,
  newTempDir,
  type GeneratedCa,
} from "../src/mtlsPki.js";
import { proxyAuthHeader } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Cert-identity ↔ agent-token tenant binding enforcement, over the mTLS
 * listener `mtls.test.ts` covers the handshake for. `GATEWAY_BINDING_ENFORCEMENT`
 * = off | log | enforce (default off) turns the verified certificate's spiffe
 * identity — looked up against `client_hosts` — into an access-control
 * decision: a relay's certificate may only carry agent tokens for its own
 * workspace.
 *
 * Runs on `onecli_gateway_e2e_template_p4` (the WP-B template carrying the
 * `client_hosts` table) — set `E2E_TEMPLATE_DB` accordingly. This branch has
 * not merged WP-B's Prisma model for `ClientHost`, so rows are inserted via
 * raw SQL against the table WP-B's migration created, mirroring the shape
 * `db::find_client_host_by_spiffe`/`ClientHostRow` read on the Rust side.
 */

// ── mTLS plumbing (mirrors mtls.test.ts's own private helpers — kept local
// rather than exported from there, since the two test files are owned by
// different work packages and neither should widen the other's surface). ──

interface MtlsPki {
  readonly dir: string;
  readonly clientCa: GeneratedCa;
  readonly serverCertPath: string;
  readonly serverKeyPath: string;
}

const setupPki = (): MtlsPki => {
  const dir = newTempDir();
  const clientCa = generateCa(dir, "Binding Test Client CA");
  const serverCert = generateServerCert(dir);
  return {
    dir,
    clientCa,
    serverCertPath: serverCert.certPath,
    serverKeyPath: serverCert.keyPath,
  };
};

/** See `mtls.test.ts`'s identical helper: `GATEWAY_MTLS_PORT` rejects `0`
 * outright, so a free port is picked up front the same way an operator would. */
const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("could not determine a free port"));
          return;
        }
        resolve(address.port);
      });
    });
  });

const mtlsEnv = async (
  pki: MtlsPki,
  extra: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> => ({
  GATEWAY_MTLS_PORT: String(await getFreePort()),
  GATEWAY_TLS_CERT: pki.serverCertPath,
  GATEWAY_TLS_KEY: pki.serverKeyPath,
  GATEWAY_CLIENT_CA: pki.clientCa.certPath,
  ...extra,
});

interface BootLine {
  readonly [key: string]: unknown;
}

const parsedLogLines = (gw: GatewayHandle): BootLine[] =>
  gw
    .logs()
    .split("\n")
    .flatMap((raw) => {
      if (raw.trim() === "") return [];
      try {
        return [JSON.parse(raw) as BootLine];
      } catch {
        return [];
      }
    });

const mtlsBoundPort = async (gw: GatewayHandle): Promise<number> => {
  await gw.waitForLog("listening for mTLS connections");
  const line = parsedLogLines(gw).find(
    (l) =>
      typeof l["message"] === "string" &&
      (l["message"] as string).includes("listening for mTLS connections"),
  );
  if (line === undefined) {
    throw new Error("mTLS boot line not found even though waitForLog resolved");
  }
  const addr = line["addr"];
  if (typeof addr !== "string") {
    throw new Error(`mTLS boot line missing a usable addr: ${JSON.stringify(line)}`);
  }
  const port = Number.parseInt(addr.split(":").pop() ?? "", 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not parse a port out of the mTLS bound address ${addr}`);
  }
  return port;
};

// ── CONNECT over the mTLS listener ──────────────────────────────────────

interface ClientCert {
  readonly cert: string;
  readonly key: string;
}

interface MtlsConnectResult {
  readonly status: number;
  readonly statusLine: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Empty for a 200 (a successful CONNECT is a bare tunnel handshake with
   * no body); the JSON error body for a denial (403/502). */
  readonly body: string;
}

/**
 * Issue a raw CONNECT over a TLS connection presenting `client`'s
 * certificate — the mTLS-listener counterpart of `proxy.ts`'s
 * `connectThroughProxy`. Unlike that helper this also captures the response
 * body via `Content-Length`, since `binding_denied()`/`bad_gateway()`'s JSON
 * shape is exactly what several assertions below pin.
 *
 * No real upstream is ever dialed: `handle_connect` answers the CONNECT
 * before the tunnel is even upgraded (the MITM dial happens afterward, in a
 * detached task this helper never waits on), so the authority just needs to
 * be well-formed — `127.0.0.1:9` (nothing ever listens there, matching the
 * "guaranteed dead" convention `PolicyEngine::test_stub()` uses on the Rust
 * side) works for every scenario here.
 */
const DEAD_AUTHORITY = "127.0.0.1:9";

const connectThroughMtlsProxy = (
  port: number,
  client: ClientCert,
  options: { readonly token?: string; readonly timeoutMs?: number } = {},
): Promise<MtlsConnectResult> =>
  new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
        cert: client.cert,
        key: client.key,
      },
      () => {
        const auth =
          options.token !== undefined
            ? `Proxy-Authorization: ${proxyAuthHeader(options.token)}\r\n`
            : "";
        socket.write(
          `CONNECT ${DEAD_AUTHORITY} HTTP/1.1\r\nHost: ${DEAD_AUTHORITY}\r\n${auth}\r\n`,
        );
      },
    );

    socket.setTimeout(options.timeoutMs ?? 15_000, () => {
      socket.destroy(new Error(`CONNECT ${DEAD_AUTHORITY} over mTLS timed out`));
    });

    let buffered = "";
    let head:
      | { statusLine: string; headers: Record<string, string>; bodyStart: number }
      | undefined;

    const settle = (result: MtlsConnectResult): void => {
      socket.destroy();
      resolve(result);
    };

    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");

      if (head === undefined) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end === -1) return;
        const [statusLine = "", ...rest] = buffered.slice(0, end).split("\r\n");
        const headers: Record<string, string> = {};
        for (const line of rest) {
          const idx = line.indexOf(":");
          if (idx > 0) {
            headers[line.slice(0, idx).trim().toLowerCase()] = line
              .slice(idx + 1)
              .trim();
          }
        }
        head = { statusLine, headers, bodyStart: end + 4 };

        const status = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
        if (status === 200) {
          settle({ status, statusLine, headers, body: "" });
          return;
        }
      }

      const contentLength = Number.parseInt(
        head.headers["content-length"] ?? "0",
        10,
      );
      const bodySoFar = buffered.length - head.bodyStart;
      if (contentLength === 0 || bodySoFar >= contentLength) {
        const status = Number.parseInt(head.statusLine.split(" ")[1] ?? "0", 10);
        settle({
          status,
          statusLine: head.statusLine,
          headers: head.headers,
          body: buffered.slice(head.bodyStart, head.bodyStart + contentLength),
        });
      }
    });

    socket.on("error", reject);
  });

// ── `client_hosts` fixture (raw SQL — see the module doc) ──────────────

const insertClientHost = async (
  prisma: PrismaClient,
  row: {
    readonly id: string;
    readonly workspaceId: string;
    readonly organizationId?: string;
    readonly spiffeUri: string;
    readonly revoked?: boolean;
  },
): Promise<void> => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO client_hosts (id, workspace_id, organization_id, spiffe_uri, revoked_at, created_at)
     VALUES ($1, $2, $3, $4, ${row.revoked === true ? "now()" : "NULL"}, now())`,
    row.id,
    row.workspaceId,
    row.organizationId ?? null,
    row.spiffeUri,
  );
};

/** Break `find_client_host_by_spiffe` itself (a genuine lookup failure), not
 * "no matching row" — dropped only in this test's own cloned database, never
 * the shared frozen template. */
const poisonClientHostsTable = (prisma: PrismaClient): Promise<unknown> =>
  prisma.$executeRawUnsafe("DROP TABLE client_hosts CASCADE");

describe("cert/token tenant binding enforcement", () => {
  scenario(
    "off mode allows a mismatched tenant without ever touching client_hosts",
    async (cx) => {
      const pki = setupPki();
      try {
        await cx.seed();
        // Poisoned, not merely mismatched: if Off resolved the host tenant
        // anyway, the query itself would fail (no such table) and this
        // would 502 instead of 200 — a direct proof of zero DB touch, not
        // just "happened to allow this particular row".
        await poisonClientHostsTable(cx.db.prisma);
        const spiffe = `spiffe://onecli/host/${cx.ids.nonce}`;
        const leaf = generateClientLeaf(pki.dir, pki.clientCa, {
          cn: "relay-1",
          uriSan: spiffe,
        });

        const gw = await cx.startGateway({ env: await mtlsEnv(pki) });
        const port = await mtlsBoundPort(gw);

        const result = await connectThroughMtlsProxy(
          port,
          { cert: leaf.certPem, key: leaf.keyPem },
          { token: cx.ids.agentToken },
        );
        expect(result.status).toBe(200);
      } finally {
        rmSync(pki.dir, { recursive: true, force: true });
      }
    },
  );

  scenario(
    "log mode allows a mismatched tenant but logs a would-deny",
    async (cx) => {
      const pki = setupPki();
      try {
        await cx.seed();
        const otherWorkspaceId = `${cx.ids.workspace}-other`;
        await cx.db.prisma.workspace.create({
          data: {
            id: otherWorkspaceId,
            name: otherWorkspaceId,
            organizationId: cx.ids.org,
          },
        });
        const spiffe = `spiffe://onecli/host/${cx.ids.nonce}`;
        await insertClientHost(cx.db.prisma, {
          id: `${cx.ids.nonce}-host`,
          workspaceId: otherWorkspaceId,
          spiffeUri: spiffe,
        });
        const leaf = generateClientLeaf(pki.dir, pki.clientCa, {
          cn: "relay-1",
          uriSan: spiffe,
        });

        const gw = await cx.startGateway({
          env: await mtlsEnv(pki, { GATEWAY_BINDING_ENFORCEMENT: "log" }),
        });
        const port = await mtlsBoundPort(gw);

        const result = await connectThroughMtlsProxy(
          port,
          { cert: leaf.certPem, key: leaf.keyPem },
          { token: cx.ids.agentToken },
        );
        expect(result.status).toBe(200);

        // The log-mode message text is distinct from enforce's ("(log mode —
        // request allowed)" vs "— request denied"), so a substring match on
        // it alone already disambiguates; the structured fields are checked
        // too since they are what an operator watching rollout actually reads.
        await gw.waitForLog("cert/token tenant mismatch (log mode");
        const line = parsedLogLines(gw).find(
          (l) => l["decision"] === "would_deny",
        );
        expect(line).toBeDefined();
        expect(line?.["reason"]).toBe("workspace_mismatch");
      } finally {
        rmSync(pki.dir, { recursive: true, force: true });
      }
    },
  );

  scenario("enforce mode denies a mismatched tenant with 403", async (cx) => {
    const pki = setupPki();
    try {
      await cx.seed();
      const otherWorkspaceId = `${cx.ids.workspace}-other`;
      await cx.db.prisma.workspace.create({
        data: {
          id: otherWorkspaceId,
          name: otherWorkspaceId,
          organizationId: cx.ids.org,
        },
      });
      const spiffe = `spiffe://onecli/host/${cx.ids.nonce}`;
      await insertClientHost(cx.db.prisma, {
        id: `${cx.ids.nonce}-host`,
        workspaceId: otherWorkspaceId,
        spiffeUri: spiffe,
      });
      const leaf = generateClientLeaf(pki.dir, pki.clientCa, {
        cn: "relay-1",
        uriSan: spiffe,
      });

      const gw = await cx.startGateway({
        env: await mtlsEnv(pki, { GATEWAY_BINDING_ENFORCEMENT: "enforce" }),
      });
      const port = await mtlsBoundPort(gw);

      const result = await connectThroughMtlsProxy(
        port,
        { cert: leaf.certPem, key: leaf.keyPem },
        { token: cx.ids.agentToken },
      );
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toMatchObject({
        error: "identity_not_permitted",
      });
      // The specific reason is server-log-only, never in the response body.
      expect(result.body).not.toContain("workspace_mismatch");
    } finally {
      rmSync(pki.dir, { recursive: true, force: true });
    }
  });

  scenario("enforce mode denies a revoked host with 403", async (cx) => {
    const pki = setupPki();
    try {
      await cx.seed();
      const spiffe = `spiffe://onecli/host/${cx.ids.nonce}`;
      // Matching workspace, but revoked — must still deny.
      await insertClientHost(cx.db.prisma, {
        id: `${cx.ids.nonce}-host`,
        workspaceId: cx.ids.workspace,
        spiffeUri: spiffe,
        revoked: true,
      });
      const leaf = generateClientLeaf(pki.dir, pki.clientCa, {
        cn: "relay-1",
        uriSan: spiffe,
      });

      const gw = await cx.startGateway({
        env: await mtlsEnv(pki, { GATEWAY_BINDING_ENFORCEMENT: "enforce" }),
      });
      const port = await mtlsBoundPort(gw);

      const result = await connectThroughMtlsProxy(
        port,
        { cert: leaf.certPem, key: leaf.keyPem },
        { token: cx.ids.agentToken },
      );
      expect(result.status).toBe(403);
    } finally {
      rmSync(pki.dir, { recursive: true, force: true });
    }
  });

  scenario(
    "enforce mode 502s on a host-lookup failure, not 403",
    async (cx) => {
      const pki = setupPki();
      try {
        await cx.seed();
        await poisonClientHostsTable(cx.db.prisma);
        const spiffe = `spiffe://onecli/host/${cx.ids.nonce}`;
        const leaf = generateClientLeaf(pki.dir, pki.clientCa, {
          cn: "relay-1",
          uriSan: spiffe,
        });

        const gw = await cx.startGateway({
          env: await mtlsEnv(pki, { GATEWAY_BINDING_ENFORCEMENT: "enforce" }),
        });
        const port = await mtlsBoundPort(gw);

        const result = await connectThroughMtlsProxy(
          port,
          { cert: leaf.certPem, key: leaf.keyPem },
          { token: cx.ids.agentToken },
        );
        expect(result.status).toBe(502);
      } finally {
        rmSync(pki.dir, { recursive: true, force: true });
      }
    },
  );
});
