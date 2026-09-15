import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { gatewayBinary } from "../src/binary.js";
import type { GatewayHandle } from "../src/gateway.js";
import { generateCa, newTempDir, type GeneratedCa } from "../src/mtlsPki.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * `onecli-gateway relay` — the local mTLS relay that carries a plain
 * HTTP-proxy agent's traffic to a remote gateway over mutual TLS.
 *
 * This suite does the actual round trip described in the phase 4 plan:
 * `relay enroll` (against a fake stand-in for the api-server's
 * `POST /v1/gateway/client-cert`) -> mTLS dial to a real `onecli-gateway` ->
 * MITM -> credential injection at a stub upstream, plus the three
 * fail-closed paths that make the relay safe to run unattended: enrollment
 * failure aborts startup, an unreachable gateway 502s, and an untrusted
 * server certificate 502s rather than falling back to anything.
 *
 * No cert<->token binding enforcement is exercised here — that is a later
 * phase (WP-D). This suite only proves the relay's own contract: the
 * agent's request reaches the gateway byte-for-byte over a connection the
 * relay authenticated with its own client certificate.
 */

// ── Throwaway PKI / CSR signing for the fake enrollment API ────────────────

const opensslQuiet = (args: readonly string[]): void => {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "ignore"] });
};

interface SignedLeaf {
  readonly certPem: string;
  readonly serial: string;
  readonly notAfterUnix: number;
}

/**
 * Sign a CSR the relay actually generated (rcgen, ECDSA P-256) under `ca`,
 * mirroring what the real gateway's `client-ca::ClientCa::sign_csr` does:
 * every identity field (the SPIFFE URI SAN here) is server-assigned, never
 * read from the CSR itself.
 */
const signCsr = (ca: GeneratedCa, csrPem: string, hostId: string): SignedLeaf => {
  const dir = mkdtempSync(join(tmpdir(), "onecli-relay-e2e-sign-"));
  try {
    const csrPath = join(dir, "csr.pem");
    const certPath = join(dir, "leaf.pem");
    const extPath = join(dir, "ext.cnf");
    writeFileSync(csrPath, csrPem);
    writeFileSync(
      extPath,
      [
        "extendedKeyUsage=clientAuth",
        "keyUsage=digitalSignature",
        `subjectAltName=URI:spiffe://onecli/host/${hostId}`,
        "",
      ].join("\n"),
    );
    opensslQuiet([
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      ca.certPath,
      "-CAkey",
      ca.keyPath,
      "-CAcreateserial",
      "-out",
      certPath,
      "-days",
      "2",
      "-extfile",
      extPath,
    ]);
    const certPem = readFileSync(certPath, "utf8");
    const serialRaw = execFileSync(
      "openssl",
      ["x509", "-in", certPath, "-noout", "-serial"],
      { encoding: "utf8" },
    );
    const serial = serialRaw.trim().split("=")[1] ?? "";
    return {
      certPem,
      serial,
      // Comfortably inside the `-days 2` window signed above.
      notAfterUnix: Math.floor(Date.now() / 1000) + 2 * 86400 - 60,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

interface RelayServerCert {
  readonly certPath: string;
  readonly keyPath: string;
}

/**
 * A throwaway self-signed server cert for the real gateway's own mTLS
 * listener identity, trusted directly by the relay via `--gateway-server-ca`
 * (the relay dials it as its OWN trust anchor -- no CA chain involved).
 *
 * Deliberately NOT `mtlsPki.ts`'s `generateServerCert`: that helper's
 * consumer (`mtls.test.ts`) verifies the CLIENT side of the handshake with
 * Node's `tls` module using `rejectUnauthorized: false`, so two things it
 * never needed bite a real rustls/webpki verifier (the relay's):
 *
 *  - an explicit `serverAuth` `extendedKeyUsage`;
 *  - `basicConstraints=CA:FALSE` -- modern OpenSSL's `req -x509` default is
 *    `CA:TRUE` even with no `-addext basicConstraints` at all, and webpki
 *    flatly refuses to verify a leaf whose basic constraints say `CA:TRUE`
 *    (`CaUsedAsEndEntity`), which is exactly what a bare `mtlsPki.ts`-style
 *    self-signed cert would trip here.
 */
const generateRelayServerCert = (dir: string): RelayServerCert => {
  const keyPath = join(dir, "relay-server-key.pem");
  const certPath = join(dir, "relay-server-cert.pem");
  opensslQuiet([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-addext",
    "extendedKeyUsage=serverAuth",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
  ]);
  return { certPath, keyPath };
};

interface FakeEnrollApi {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Stands in for the api-server's `POST /v1/gateway/client-cert`
 * (`packages/api/src/routes/gateway.ts`'s `clientCertRoutes`): parses
 * `{csrPem, label?, hostId?}`, signs the CSR under `clientCa`, and answers
 * the camelCase `{identity, hostId, certPem, caPem, serial, notAfter}` shape
 * `relay::enroll::EnrollResponseBody` deserializes.
 */
const startFakeEnrollApi = (clientCa: GeneratedCa): Promise<FakeEnrollApi> => {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/gateway/client-cert") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = parsed as { csrPem?: string; hostId?: string };
        if (typeof body.csrPem !== "string") {
          res.writeHead(400).end("missing csrPem");
          return;
        }
        const hostId = body.hostId ?? randomUUID();
        const leaf = signCsr(clientCa, body.csrPem, hostId);
        const payload = JSON.stringify({
          identity: `spiffe://onecli/host/${hostId}`,
          hostId,
          certPem: `${leaf.certPem}${clientCa.certPem}`,
          caPem: clientCa.certPem,
          serial: leaf.serial,
          notAfter: leaf.notAfterUnix,
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake enroll API could not determine its bound address");
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
};

/**
 * A genuinely free port, picked up front the same way `mtls.test.ts` does:
 * `GATEWAY_MTLS_PORT` (unlike `--port 0`) rejects `0` outright.
 */
const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createTcpServer();
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

// ── Driving the relay subprocess ────────────────────────────────────────

interface RelayOptions {
  readonly gatewayAddr: string;
  readonly gatewayServerCaPath: string;
  readonly apiUrl: string;
  readonly apiKey?: string;
}

interface LogLine {
  readonly raw: string;
  readonly parsed: Record<string, unknown> | null;
}

interface RelayProcess {
  logs(): string;
  waitForLine(needle: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForExit(
    timeoutMs?: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): void;
}

const messageIncludes =
  (needle: string) =>
  (line: Record<string, unknown>): boolean => {
    const message = line["message"];
    return typeof message === "string" && message.includes(needle);
  };

/**
 * Spawn `onecli-gateway relay` directly (not through `gateway.ts`'s
 * `startGateway`, which is wired specifically for server mode's
 * `--port`/`/healthz` readiness contract). The relay logs its own distinct
 * readiness line ("relay listening"), never "listening for connections" —
 * so this never risks confusion with the plaintext-listener readiness wait
 * the rest of the suite relies on.
 */
const spawnRelay = (options: RelayOptions): RelayProcess => {
  const args = [
    "relay",
    "--bind",
    "127.0.0.1:0",
    "--gateway-addr",
    options.gatewayAddr,
    "--gateway-server-ca",
    options.gatewayServerCaPath,
    "--api-url",
    options.apiUrl,
    "--api-key",
    options.apiKey ?? "oc_e2e_relay_test",
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LOG_FORMAT: "json",
    RUST_LOG: process.env.GATEWAY_E2E_RUST_LOG ?? "info",
  };

  const child = spawn(gatewayBinary(), args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: LogLine[] = [];
  let buffer = "";
  const waiters = new Set<{
    match: (line: Record<string, unknown>) => boolean;
    resolve: (line: Record<string, unknown>) => void;
  }>();

  const push = (chunk: string): void => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const raw of parts) {
      if (raw.trim() === "") continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value === "object" && value !== null) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        // Non-JSON output (a panic, a rustls warning) is still worth keeping.
      }
      lines.push({ raw, parsed });
      if (parsed !== null) {
        for (const waiter of waiters) {
          if (waiter.match(parsed)) {
            waiters.delete(waiter);
            waiter.resolve(parsed);
          }
        }
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", push);
  child.stderr.on("data", push);

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitWaiters = new Set<
    (result: { code: number | null; signal: NodeJS.Signals | null }) => void
  >();
  child.on("close", (code, signal) => {
    exited = { code, signal };
    for (const waiter of exitWaiters) waiter(exited);
    exitWaiters.clear();
  });

  return {
    logs: () => lines.map((l) => l.raw).join("\n"),
    waitForLine: (needle, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const match = messageIncludes(needle);
        const existing = lines.find((l) => l.parsed !== null && match(l.parsed));
        if (existing?.parsed) {
          resolve(existing.parsed);
          return;
        }
        const waiter = {
          match,
          resolve: (line: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(line);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(
              `relay never logged "${needle}" within ${String(timeoutMs)}ms\n--- relay output ---\n${lines
                .map((l) => l.raw)
                .join("\n")}`,
            ),
          );
        }, timeoutMs);
        waiters.add(waiter);
      }),
    waitForExit: (timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        if (exited !== undefined) {
          resolve(exited);
          return;
        }
        const timer = setTimeout(() => {
          exitWaiters.delete(waiter);
          reject(new Error(`relay did not exit within ${String(timeoutMs)}ms`));
        }, timeoutMs);
        const waiter = (result: {
          code: number | null;
          signal: NodeJS.Signals | null;
        }): void => {
          clearTimeout(timer);
          resolve(result);
        };
        exitWaiters.add(waiter);
      }),
    stop: () => {
      if (exited === undefined) child.kill("SIGKILL");
    },
  };
};

/** Wait for the relay's own readiness line and parse its bound port from it. */
const relayBoundPort = async (relay: RelayProcess): Promise<number> => {
  const line = await relay.waitForLine("relay listening");
  const addr = line["addr"];
  if (typeof addr !== "string") {
    throw new Error(`relay listening line missing a usable addr: ${JSON.stringify(line)}`);
  }
  const port = Number.parseInt(addr.split(":").pop() ?? "", 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not parse a port out of the relay's bound address ${addr}`);
  }
  return port;
};

/**
 * Send raw bytes to the relay's bind port and collect whatever comes back
 * within a short window. Raw `net`, not `throughProxy`: the fail-closed
 * paths under test answer with a bare `502` and no `Content-Length`, which
 * would leave Node's `http` client waiting for a body that never arrives.
 */
const rawTunnelProbe = (port: number, requestLine: string): Promise<Buffer> =>
  new Promise((resolve) => {
    const socket = netConnect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const finish = (): void => {
      socket.destroy();
      resolve(Buffer.concat(chunks));
    };
    socket.once("connect", () => socket.write(requestLine));
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.once("close", finish);
    socket.once("error", finish);
    setTimeout(finish, 5_000);
  });

const CONNECT_PROBE = "CONNECT example.com:443 HTTP/1.1\r\n\r\n";
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\n\r\n";

const waitForMtls = (gw: GatewayHandle): Promise<void> =>
  gw.waitForLog("listening for mTLS connections");

describe("relay subcommand", () => {
  scenario(
    "carries a proxied request through the gateway, injecting the configured credential",
    async (cx) => {
      const dir = newTempDir();
      let fakeApi: FakeEnrollApi | undefined;
      let relay: RelayProcess | undefined;
      try {
        const clientCa = generateCa(dir, "Relay E2E Client CA");
        const serverCert = generateRelayServerCert(dir);
        fakeApi = await startFakeEnrollApi(clientCa);

        const upstream = await cx.upstream();
        await cx.seed({
          grantAll: true,
          secrets: [
            {
              hostPattern: "127.0.0.1",
              headerName: "x-test-key",
              value: "sk-relay-e2e-injected",
            },
          ],
        });

        const mtlsPort = await getFreePort();
        const gw = await cx.startGateway({
          env: {
            GATEWAY_MTLS_PORT: String(mtlsPort),
            GATEWAY_TLS_CERT: serverCert.certPath,
            GATEWAY_TLS_KEY: serverCert.keyPath,
            GATEWAY_CLIENT_CA: clientCa.certPath,
          },
        });
        await waitForMtls(gw);

        relay = spawnRelay({
          gatewayAddr: `127.0.0.1:${String(mtlsPort)}`,
          gatewayServerCaPath: serverCert.certPath,
          apiUrl: fakeApi.url,
        });
        const relayPort = await relayBoundPort(relay);

        const res = await throughProxy(`http://127.0.0.1:${String(relayPort)}`, {
          url: upstream.url("/v1/models"),
          token: cx.ids.agentToken,
        });

        expect(res.status).toBe(200);
        const [seen] = await upstream.waitForRequests(1);
        // The whole chain in one assertion: the relay's own client
        // certificate got it through the gateway's mTLS listener, the
        // agent's Proxy-Authorization reached the gateway untouched, and
        // the gateway resolved + injected a credential it never told the
        // agent (or the relay) about.
        expect(seen?.header("x-test-key")).toBe("sk-relay-e2e-injected");
      } finally {
        relay?.stop();
        await fakeApi?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  scenario("refuses to start when enrollment fails", async () => {
    const dir = newTempDir();
    let relay: RelayProcess | undefined;
    try {
      // Any parseable PEM works as the trust anchor here -- enrollment
      // fails before the relay ever dials a gateway.
      const ca = generateCa(dir, "Relay E2E Trust Anchor");
      relay = spawnRelay({
        gatewayAddr: "127.0.0.1:1",
        gatewayServerCaPath: ca.certPath,
        // Port 1 (tcpmux) is essentially guaranteed unbound: an immediate
        // connection refusal, not a hang.
        apiUrl: "http://127.0.0.1:1",
      });

      const exit = await relay.waitForExit();
      expect(exit.code).not.toBe(0);
      expect(relay.logs().toLowerCase()).toContain("enrollment");
      expect(relay.logs()).not.toContain("relay listening");
    } finally {
      relay?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  scenario("returns 502 when the remote gateway is unreachable", async () => {
    const dir = newTempDir();
    let fakeApi: FakeEnrollApi | undefined;
    let relay: RelayProcess | undefined;
    try {
      const clientCa = generateCa(dir, "Relay E2E Client CA");
      fakeApi = await startFakeEnrollApi(clientCa);

      relay = spawnRelay({
        // Enrollment succeeds against the fake API above; only the SPLICE
        // target is unreachable, proving the fail-closed path is in the
        // tunnel, not just at startup.
        gatewayAddr: "127.0.0.1:1",
        gatewayServerCaPath: clientCa.certPath,
        apiUrl: fakeApi.url,
      });
      const relayPort = await relayBoundPort(relay);

      const response = await rawTunnelProbe(relayPort, CONNECT_PROBE);
      expect(response.toString("utf8")).toBe(BAD_GATEWAY);
    } finally {
      relay?.stop();
      await fakeApi?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  scenario(
    "returns 502 rather than trusting an untrusted remote server certificate",
    async (cx) => {
      const dir = newTempDir();
      let fakeApi: FakeEnrollApi | undefined;
      let relay: RelayProcess | undefined;
      try {
        const clientCa = generateCa(dir, "Relay E2E Client CA");
        const serverCert = generateRelayServerCert(dir);
        // A trust anchor the relay is given that does NOT match the real
        // gateway's server certificate above.
        const wrongServerCa = generateCa(dir, "Relay E2E Wrong Server CA");
        fakeApi = await startFakeEnrollApi(clientCa);

        const mtlsPort = await getFreePort();
        const gw = await cx.startGateway({
          env: {
            GATEWAY_MTLS_PORT: String(mtlsPort),
            GATEWAY_TLS_CERT: serverCert.certPath,
            GATEWAY_TLS_KEY: serverCert.keyPath,
            GATEWAY_CLIENT_CA: clientCa.certPath,
          },
        });
        await waitForMtls(gw);

        relay = spawnRelay({
          gatewayAddr: `127.0.0.1:${String(mtlsPort)}`,
          gatewayServerCaPath: wrongServerCa.certPath,
          apiUrl: fakeApi.url,
        });
        const relayPort = await relayBoundPort(relay);

        const response = await rawTunnelProbe(relayPort, CONNECT_PROBE);
        expect(response.toString("utf8")).toBe(BAD_GATEWAY);
      } finally {
        relay?.stop();
        await fakeApi?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
