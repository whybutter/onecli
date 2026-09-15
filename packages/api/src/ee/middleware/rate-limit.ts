import type { Context, Env, MiddlewareHandler } from "hono";
import type { ApiEnv } from "../../types";

export interface RateLimitOptions<E extends Env = ApiEnv> {
  /** Bucket namespace, e.g. `auth-session`. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Derives the bucket key from the request (an IP, an org, a token). */
  key: (c: Context<E>) => string;
}

/**
 * The fixed-window limiter was Redis-backed, and Redis is dropped. Its
 * documented degraded mode when no Redis is configured was "off", so the
 * stand-in is that mode made permanent: a pass-through middleware.
 */
export const rateLimit = <E extends Env = ApiEnv>(
  options: RateLimitOptions<E>,
): MiddlewareHandler<E> => {
  void options;
  return async (_c, next) => {
    await next();
  };
};

/**
 * The client address a per-IP bucket keys on: the CloudFront viewer address
 * with its port stripped, else the first `x-forwarded-for` hop, else
 * `"unknown"`. Pure, so it stays real.
 */
export const clientIpKey = (c: Context<ApiEnv>): string => {
  const viewer = c.req.header("cloudfront-viewer-address");
  if (viewer) {
    const withoutPort = viewer.replace(/:\d+$/, "");
    if (withoutPort) return withoutPort;
  }
  const forwarded = c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
};
