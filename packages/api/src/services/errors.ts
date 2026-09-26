export type ServiceErrorCode =
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "UNPROCESSABLE"
  | "CONFLICT"
  | "FORBIDDEN"
  | "GONE"
  | "RATE_LIMITED"
  // The gateway's client-cert minting endpoint is unreachable, or reachable
  // but has no minting authority configured (`state.client_ca` is `None`) —
  // see `mintClientCert` in `lib/gateway-client-cert.ts`.
  | "SERVICE_UNAVAILABLE";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ServiceError";
  }
}
