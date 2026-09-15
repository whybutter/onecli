import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway PKI generation for the mTLS e2e suite, via the `openssl` CLI —
 * present on both macOS and the CI runner, same rationale as
 * `upstream.ts`'s `selfSignedCert`. Every cert here is EC P-256, short-lived,
 * and thrown away with its temp directory at test teardown.
 */

const opensslQuiet = (args: readonly string[]): void => {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "ignore"] });
};

export const newTempDir = (): string =>
  mkdtempSync(join(tmpdir(), "onecli-mtls-e2e-"));

export interface GeneratedCa {
  readonly certPath: string;
  readonly keyPath: string;
  readonly certPem: string;
}

/** A throwaway CA: self-signed, `CA:TRUE`, `keyCertSign`+`cRLSign`. */
export const generateCa = (dir: string, cn: string): GeneratedCa => {
  const slug = cn.replace(/\W+/g, "_");
  const keyPath = join(dir, `${slug}-ca-key.pem`);
  const certPath = join(dir, `${slug}-ca-cert.pem`);
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
    "3650",
    "-subj",
    `/CN=${cn}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  return { certPath, keyPath, certPem: readFileSync(certPath, "utf8") };
};

export interface GeneratedLeaf {
  readonly certPath: string;
  readonly keyPath: string;
  readonly certPem: string;
  readonly keyPem: string;
}

/**
 * A throwaway server cert, self-signed for `127.0.0.1` — the mTLS listener's
 * own TLS identity. `mtls.test.ts`/`binding.test.ts` connect with
 * `rejectUnauthorized: false` (server identity is not what those suites
 * verify, client-certificate enforcement is), but `relay.test.ts` dials the
 * real gateway with a real rustls/webpki client and DOES verify this cert,
 * which is why it carries an explicit `serverAuth` EKU and
 * `basicConstraints=CA:FALSE`: modern OpenSSL's `req -x509` defaults a
 * self-signed cert to `CA:TRUE` even with no `-addext basicConstraints` at
 * all, and webpki flatly refuses to verify a leaf whose basic constraints
 * say `CA:TRUE` (`CaUsedAsEndEntity`).
 */
export const generateServerCert = (dir: string): GeneratedLeaf => {
  const keyPath = join(dir, "server-key.pem");
  const certPath = join(dir, "server-cert.pem");
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
  return {
    certPath,
    keyPath,
    certPem: readFileSync(certPath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
};

export interface ClientLeafOptions {
  readonly cn: string;
  readonly uriSan?: string;
  /** `openssl -not_before`/`-not_after` format: `[CC]YYMMDDHHMMSSZ`. Both or
   *  neither — omit to get a leaf valid from now for one day. */
  readonly notBefore?: string;
  readonly notAfter?: string;
}

/** Sign a client leaf (`clientAuth` EKU) under `ca`, from a fresh CSR. */
export const generateClientLeaf = (
  dir: string,
  ca: GeneratedCa,
  options: ClientLeafOptions,
): GeneratedLeaf => {
  const slug = options.cn.replace(/\W+/g, "_");
  const keyPath = join(dir, `${slug}-key.pem`);
  const csrPath = join(dir, `${slug}-csr.pem`);
  const certPath = join(dir, `${slug}-cert.pem`);
  const extPath = join(dir, `${slug}-ext.cnf`);

  opensslQuiet([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    csrPath,
    "-subj",
    `/CN=${options.cn}`,
  ]);

  const ext = [
    "extendedKeyUsage=clientAuth",
    "keyUsage=digitalSignature",
    ...(options.uriSan !== undefined
      ? [`subjectAltName=URI:${options.uriSan}`]
      : []),
  ].join("\n");
  writeFileSync(extPath, `${ext}\n`);

  const args = [
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
    "-extfile",
    extPath,
  ];
  if (options.notBefore !== undefined && options.notAfter !== undefined) {
    args.push("-not_before", options.notBefore, "-not_after", options.notAfter);
  } else {
    args.push("-days", "1");
  }
  opensslQuiet(args);

  return {
    certPath,
    keyPath,
    certPem: readFileSync(certPath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
};
