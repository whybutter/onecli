import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect } from "vitest";

import { scenario } from "../src/scenario.js";

const execFileAsync = promisify(execFile);

/**
 * `POST /v1/internal/client-cert/issue` — the gateway-internal endpoint
 * behind `X-Gateway-Secret`, not session/API-key auth (see
 * `crates/server/src/client_cert_route.rs`'s module doc for why this check
 * is a NEW inbound-direction pair, not a reuse of
 * `vault::onepassword_api`'s outbound one).
 *
 * Gateway-internal half only — the Node-side contract (`POST
 * /v1/gateway/client-cert`, `ensureClientHost`'s IDOR fence, audit shape) is
 * covered by `packages/api`'s own test suite
 * (`gateway-client-cert.test.ts`, `client-host-service.pg.test.ts`); this
 * suite only proves the boundary the gateway itself enforces.
 *
 * Runs on template `_p4` (`ClientHost`'s migration applied) — that table is
 * never touched by these tests (no DB call in `issue_client_cert`), but the
 * gateway process must boot against a schema `prisma migrate deploy` has
 * actually reached, matching every other scenario in this suite.
 */

const GATEWAY_INTERNAL_SECRET = "e2e-test-gateway-internal-secret";

const VALID_CSR_PEM = (() => {
  // A syntactically valid, but not a REAL, CSR is fine for the fail-closed
  // (secret) matrix and the 503 (no CA) case — the request never reaches
  // `sign_csr` in either. The round-trip test below needs a real one, built
  // with node:crypto so this suite has no new dependency.
  return "-----BEGIN CERTIFICATE REQUEST-----\nMIIBazCB7QIBADAA\n-----END CERTIFICATE REQUEST-----\n";
})();

const issueClientCert = (
  origin: string,
  body: unknown,
  secret?: string,
): Promise<Response> =>
  fetch(`${origin}/v1/internal/client-cert/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "x-gateway-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });

/**
 * A real, freshly generated CSR — the gateway's `sign_csr` re-parses and
 * re-verifies it independently (never trusts a caller's own
 * well-formedness check), so the issuance round trip needs a genuinely
 * valid one. node:crypto has no built-in CSR (PKCS#10) builder, so this
 * shells out to the `openssl` CLI (already assumed present by the gateway's
 * own build/cert tooling) to generate a fresh key + CSR in one step.
 */
const generateRealCsrPem = async (commonName: string): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "onecli-csr-"));
  const keyPath = join(dir, "key.pem");
  const csrPath = join(dir, "csr.pem");

  await execFileAsync("openssl", [
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-noenc",
    "-keyout",
    keyPath,
    "-out",
    csrPath,
    "-subj",
    `/CN=${commonName}`,
  ]);

  return readFileSync(csrPath, "utf8");
};

describe("POST /v1/internal/client-cert/issue", () => {
  scenario("401s without the X-Gateway-Secret header", async (cx) => {
    const gw = await cx.startGateway({
      env: { GATEWAY_INTERNAL_SECRET },
    });

    const res = await issueClientCert(gw.origin, { csr_pem: VALID_CSR_PEM });
    expect(res.status).toBe(401);
  });

  scenario("401s with the wrong X-Gateway-Secret", async (cx) => {
    const gw = await cx.startGateway({
      env: { GATEWAY_INTERNAL_SECRET },
    });

    const res = await issueClientCert(
      gw.origin,
      { csr_pem: VALID_CSR_PEM },
      "not-the-right-secret",
    );
    expect(res.status).toBe(401);
  });

  scenario(
    "401s with an empty X-Gateway-Secret header against a configured secret",
    async (cx) => {
      const gw = await cx.startGateway({
        env: { GATEWAY_INTERNAL_SECRET },
      });

      const res = await issueClientCert(
        gw.origin,
        { csr_pem: VALID_CSR_PEM },
        "",
      );
      expect(res.status).toBe(401);
    },
  );

  scenario(
    "503s when GATEWAY_CLIENT_CA is operator-set (no local minting authority)",
    async (cx) => {
      // Any non-empty value disables local client-CA generation (see
      // `main.rs`'s `operator_configured_client_ca` check) without needing
      // GATEWAY_MTLS_PORT set — `MtlsConfig::from_env` short-circuits before
      // ever reading GATEWAY_CLIENT_CA when mTLS itself is off.
      const gw = await cx.startGateway({
        env: {
          GATEWAY_INTERNAL_SECRET,
          GATEWAY_CLIENT_CA: "externally-managed-trust-anchor-not-a-real-pem",
        },
      });

      const res = await issueClientCert(
        gw.origin,
        {
          host_id: "h",
          spiffe_uri: "spiffe://onecli/host/h",
          csr_pem: VALID_CSR_PEM,
        },
        GATEWAY_INTERNAL_SECRET,
      );
      expect(res.status).toBe(503);
    },
  );

  scenario(
    "400s on a malformed CSR with a valid secret and a configured authority",
    async (cx) => {
      const gw = await cx.startGateway({
        env: { GATEWAY_INTERNAL_SECRET },
      });

      const res = await issueClientCert(
        gw.origin,
        {
          host_id: "h",
          spiffe_uri: "spiffe://onecli/host/h",
          csr_pem: "not a csr",
        },
        GATEWAY_INTERNAL_SECRET,
      );
      expect(res.status).toBe(400);
    },
  );

  scenario(
    "issuance round trip: a real CSR mints a verifiable cert chain with no key material",
    async (cx) => {
      const gw = await cx.startGateway({
        env: { GATEWAY_INTERNAL_SECRET },
      });

      let csrPem: string;
      try {
        csrPem = await generateRealCsrPem("e2e-test-host");
      } catch (err) {
        // No `openssl` on PATH — surface as a clear skip-worthy failure
        // rather than a cryptic downstream 400.
        throw new Error(
          `could not generate a real CSR via openssl (required for this test): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const res = await issueClientCert(
        gw.origin,
        {
          host_id: "e2e-host-1",
          spiffe_uri: "spiffe://onecli/host/e2e-host-1",
          csr_pem: csrPem,
        },
        GATEWAY_INTERNAL_SECRET,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        cert_pem: string;
        ca_pem: string;
        serial_hex: string;
        not_after_unix: number;
      };
      expect(body.cert_pem).toContain("-----BEGIN CERTIFICATE-----");
      expect(body.ca_pem).toContain("-----BEGIN CERTIFICATE-----");
      expect(body.serial_hex).toMatch(/^[0-9a-f]+$/);
      expect(body.not_after_unix).toBeGreaterThan(Date.now() / 1000);

      // No key material anywhere in the response.
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("PRIVATE KEY");

      // Exactly the four documented fields — nothing else leaked through.
      expect(Object.keys(body).sort()).toEqual(
        ["ca_pem", "cert_pem", "not_after_unix", "serial_hex"].sort(),
      );
    },
  );

  scenario("413s on an oversized body even with a valid secret", async (cx) => {
    const gw = await cx.startGateway({
      env: { GATEWAY_INTERNAL_SECRET },
    });

    const oversized = "a".repeat(16 * 1024 + 1);
    const res = await fetch(`${gw.origin}/v1/internal/client-cert/issue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-secret": GATEWAY_INTERNAL_SECRET,
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });
});
