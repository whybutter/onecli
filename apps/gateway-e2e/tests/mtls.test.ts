import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { describe, expect } from "vitest";

import type { GatewayHandle } from "../src/gateway.js";
import {
  generateCa,
  generateClientLeaf,
  generateServerCert,
  newTempDir,
  type GeneratedCa,
  type GeneratedLeaf,
} from "../src/mtlsPki.js";
import { scenario } from "../src/scenario.js";

/**
 * The mTLS listener: a second, independent front door requiring a client
 * certificate, alongside the plaintext one every other test in this suite
 * exercises. No cert↔token binding enforcement exists yet (a later phase) —
 * these tests only cover the handshake itself: who gets in, who doesn't, and
 * that the shared router (`/healthz`) answers identically on both listeners.
 */

/** Everything a test needs to configure `GATEWAY_MTLS_PORT` and friends. */
interface MtlsPki {
  readonly dir: string;
  readonly clientCa: GeneratedCa;
  readonly serverCert: GeneratedLeaf;
  /** Signed by `clientCa`, valid now — the "accepted" case. */
  readonly validLeaf: GeneratedLeaf;
  /** Signed by a DIFFERENT CA the gateway does not trust. */
  readonly wrongCaLeaf: GeneratedLeaf;
  /** Signed by `clientCa`, but its validity window is entirely in the past. */
  readonly expiredLeaf: GeneratedLeaf;
}

const setupPki = (): MtlsPki => {
  const dir = newTempDir();
  const clientCa = generateCa(dir, "Test Client CA");
  const otherCa = generateCa(dir, "Wrong CA");
  return {
    dir,
    clientCa,
    serverCert: generateServerCert(dir),
    validLeaf: generateClientLeaf(dir, clientCa, {
      cn: "agent-1",
      uriSan: "spiffe://onecli/agent/1",
    }),
    wrongCaLeaf: generateClientLeaf(dir, otherCa, { cn: "agent-wrong-ca" }),
    expiredLeaf: generateClientLeaf(dir, clientCa, {
      cn: "agent-expired",
      notBefore: "20200101000000Z",
      notAfter: "20200102000000Z",
    }),
  };
};

/**
 * `GATEWAY_MTLS_PORT` (unlike `--port 0` for the plaintext listener) rejects
 * `0` outright (`MtlsConfig::from_parts` — an explicit port is part of the
 * mTLS listener's fail-closed posture, not "let the OS pick"), so this picks
 * a genuinely free port up front the same way an operator would: bind
 * ephemeral, read it, close it, hand it to the gateway. A small TOCTOU race
 * is inherent to this pattern everywhere it's used; acceptable for a test.
 */
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

const mtlsEnv = async (pki: MtlsPki): Promise<Record<string, string>> => ({
  GATEWAY_MTLS_PORT: String(await getFreePort()),
  GATEWAY_TLS_CERT: pki.serverCert.certPath,
  GATEWAY_TLS_KEY: pki.serverCert.keyPath,
  GATEWAY_CLIENT_CA: pki.clientCa.certPath,
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

/**
 * Parse the mTLS listener's bound port out of its distinct boot line
 * ("listening for mTLS connections" — deliberately different text from the
 * plaintext listener's "listening for connections", so the two can never be
 * confused by a log-scanning test or by `gateway.ts`'s own readiness wait).
 *
 * `run_all` starts both entrypoints concurrently, so nothing guarantees
 * ordering between the two boot lines — this waits for the mTLS one
 * specifically, independent of `startGateway`'s own (plaintext-only)
 * readiness wait having already resolved.
 */
const mtlsBoundPort = async (gw: GatewayHandle): Promise<number> => {
  await gw.waitForLog("listening for mTLS connections");
  const line = parsedLogLines(gw).find(
    (l) =>
      typeof l["message"] === "string" &&
      (l["message"] as string).includes("listening for mTLS connections"),
  );
  if (line === undefined) {
    throw new Error(
      "mTLS boot line not found even though waitForLog resolved",
    );
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

interface ClientCert {
  readonly cert: string;
  readonly key: string;
}

interface RequestOutcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly body?: string;
}

/**
 * Attempt a `GET /healthz` over a fresh TLS connection to the mTLS listener,
 * presenting `client`'s certificate (or none). Server identity is
 * deliberately never checked (`rejectUnauthorized: false`): this suite is
 * about client-cert enforcement, not the listener's own TLS server identity.
 *
 * Deliberately does NOT resolve on the client's own `secureConnect` event: in
 * TLS 1.3, a client can reach its own "handshake complete" state — and see
 * `secureConnect` fire — before the SERVER has finished validating the
 * client's certificate, since client-cert verification happens after the
 * client's Finished message; a server that rejects the certificate then
 * tears the connection down with a POST-handshake alert. Resolving on
 * `secureConnect` alone would race that alert and read a genuine rejection
 * as acceptance. Only an actual HTTP response — or the connection dying
 * first — is authoritative.
 */
const attemptRequest = (
  port: number,
  client?: ClientCert,
): Promise<RequestOutcome> =>
  new Promise((resolve) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      rejectUnauthorized: false,
      cert: client?.cert,
      key: client?.key,
    });
    let buffer = "";
    let settled = false;
    const settle = (outcome: RequestOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.once("secureConnect", () => {
      socket.write(
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const statusLine = buffer.split("\r\n")[0] ?? "";
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      if (match?.[1] === undefined) {
        settle({ ok: false });
        return;
      }
      settle({
        ok: true,
        status: Number.parseInt(match[1], 10),
        body: buffer.slice(headerEnd + 4),
      });
    });
    socket.once("error", () => settle({ ok: false }));
    socket.once("close", () => settle({ ok: false }));
  });

describe("mTLS listener", () => {
  scenario("rejects a connection with no client certificate", async (cx) => {
    const pki = setupPki();
    try {
      const gw = await cx.startGateway({ env: await mtlsEnv(pki) });
      const port = await mtlsBoundPort(gw);

      const result = await attemptRequest(port);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(pki.dir, { recursive: true, force: true });
    }
  });

  scenario(
    "rejects a client certificate signed by an untrusted CA",
    async (cx) => {
      const pki = setupPki();
      try {
        const gw = await cx.startGateway({ env: await mtlsEnv(pki) });
        const port = await mtlsBoundPort(gw);

        const result = await attemptRequest(port, {
          cert: pki.wrongCaLeaf.certPem,
          key: pki.wrongCaLeaf.keyPem,
        });
        expect(result.ok).toBe(false);
      } finally {
        rmSync(pki.dir, { recursive: true, force: true });
      }
    },
  );

  scenario("rejects an expired client certificate", async (cx) => {
    const pki = setupPki();
    try {
      const gw = await cx.startGateway({ env: await mtlsEnv(pki) });
      const port = await mtlsBoundPort(gw);

      const result = await attemptRequest(port, {
        cert: pki.expiredLeaf.certPem,
        key: pki.expiredLeaf.keyPem,
      });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(pki.dir, { recursive: true, force: true });
    }
  });

  scenario(
    "accepts a valid client certificate and answers /healthz",
    async (cx) => {
      const pki = setupPki();
      try {
        const gw = await cx.startGateway({ env: await mtlsEnv(pki) });
        const port = await mtlsBoundPort(gw);

        const result = await attemptRequest(port, {
          cert: pki.validLeaf.certPem,
          key: pki.validLeaf.keyPem,
        });
        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body ?? "")).toMatchObject({ status: "ok" });
      } finally {
        rmSync(pki.dir, { recursive: true, force: true });
      }
    },
  );

  scenario(
    "boots both listeners, and the plaintext readiness wait is unaffected",
    async (cx) => {
      const pki = setupPki();
      try {
        // `cx.startGateway` resolving at all already proves the existing
        // plaintext readiness wait (boot line + /healthz 200) still works
        // with mTLS configured alongside it.
        const gw = await cx.startGateway({ env: await mtlsEnv(pki) });
        await mtlsBoundPort(gw);

        const lines = parsedLogLines(gw).map((l) => l["message"]);
        expect(lines).toContain("listening for connections");
        expect(lines).toContain("listening for mTLS connections");

        const res = await fetch(`${gw.origin}/healthz`);
        expect(res.status).toBe(200);
      } finally {
        rmSync(pki.dir, { recursive: true, force: true });
      }
    },
  );

  scenario(
    "GATEWAY_PLAIN_BIND restricts the plaintext listener's bound address",
    async (cx) => {
      const pki = setupPki();
      try {
        const gw = await cx.startGateway({
          env: { ...(await mtlsEnv(pki)), GATEWAY_PLAIN_BIND: "127.0.0.1" },
        });
        await mtlsBoundPort(gw);

        // The sandboxed e2e environment has no non-loopback interface to
        // prove refusal against, so — per the plan — assert the bound
        // address the gateway itself reports instead.
        const plainLine = parsedLogLines(gw).find(
          (l) => l["message"] === "listening for connections",
        );
        expect(plainLine).toBeDefined();
        expect(String(plainLine?.["addr"])).toMatch(/^127\.0\.0\.1:/);

        // The listener still works on loopback — GATEWAY_PLAIN_BIND narrows
        // the bind, it doesn't break the plaintext listener.
        const res = await fetch(`${gw.origin}/healthz`);
        expect(res.status).toBe(200);
      } finally {
        rmSync(pki.dir, { recursive: true, force: true });
      }
    },
  );
});
