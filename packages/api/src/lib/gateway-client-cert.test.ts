import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintClientCert } from "./gateway-client-cert";
import { ServiceError } from "../services/errors";

/**
 * `mintClientCert`'s URL-resolution guard: `GATEWAY_INTERNAL_URL`'s fallback
 * (`gatewayHttpOrigin()`) is the operator's PUBLIC gateway origin, so a split
 * deployment that leaves `GATEWAY_INTERNAL_URL` unset would otherwise send
 * `X-Gateway-Secret` — which authorizes minting a client certificate for ANY
 * spiffe URI the caller names — over plaintext HTTP to a non-loopback host.
 * HTTPS is fine anywhere; plain HTTP is fine only to loopback.
 */

const ORIGINAL_INTERNAL_URL = process.env.GATEWAY_INTERNAL_URL;

const setInternalUrl = (url: string | undefined) => {
  if (url === undefined) delete process.env.GATEWAY_INTERNAL_URL;
  else process.env.GATEWAY_INTERNAL_URL = url;
};

beforeEach(() => {
  setInternalUrl(undefined);
});

afterEach(() => {
  setInternalUrl(ORIGINAL_INTERNAL_URL);
  vi.unstubAllGlobals();
});

const okFetch = () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      cert_pem: "CERT",
      ca_pem: "CA",
      serial_hex: "abc123",
      not_after_unix: 1893456000,
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const params = {
  hostId: "host-1",
  spiffeUri: "spiffe://onecli/host/host-1",
  csrPem:
    "-----BEGIN CERTIFICATE REQUEST-----\nx\n-----END CERTIFICATE REQUEST-----\n",
};

describe("mintClientCert — internal URL scheme/host guard", () => {
  it("refuses plain HTTP to a non-loopback host, before ever calling fetch", async () => {
    setInternalUrl("http://gateway.internal.example.com:10255");
    const fetchMock = okFetch();

    await expect(mintClientCert(params)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    } satisfies Partial<ServiceError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses plain HTTP to a non-loopback IP literal", async () => {
    setInternalUrl("http://203.0.113.5:10255");
    const fetchMock = okFetch();

    await expect(mintClientCert(params)).rejects.toThrow(ServiceError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names GATEWAY_INTERNAL_URL as the remedy in the refusal message", async () => {
    setInternalUrl("http://gateway.internal.example.com:10255");
    okFetch();

    await expect(mintClientCert(params)).rejects.toThrow(
      /GATEWAY_INTERNAL_URL/,
    );
  });

  it("allows HTTPS to a non-loopback host", async () => {
    setInternalUrl("https://gateway.internal.example.com");
    const fetchMock = okFetch();

    const result = await mintClientCert(params);
    expect(result.serial).toBe("abc123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.internal.example.com/v1/internal/client-cert/issue",
      expect.anything(),
    );
  });

  it("allows plain HTTP to 127.0.0.1 (loopback)", async () => {
    setInternalUrl("http://127.0.0.1:10255");
    const fetchMock = okFetch();

    const result = await mintClientCert(params);
    expect(result.serial).toBe("abc123");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:10255/v1/internal/client-cert/issue",
      expect.anything(),
    );
  });

  it("allows plain HTTP to localhost (loopback)", async () => {
    setInternalUrl("http://localhost:10255");
    okFetch();

    const result = await mintClientCert(params);
    expect(result.serial).toBe("abc123");
  });

  it("allows plain HTTP to the IPv6 loopback literal", async () => {
    setInternalUrl("http://[::1]:10255");
    okFetch();

    const result = await mintClientCert(params);
    expect(result.serial).toBe("abc123");
  });
});
