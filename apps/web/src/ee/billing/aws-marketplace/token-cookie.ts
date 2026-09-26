/**
 * AWS Marketplace billing is cloud-only and this fork is onprem-only, but the
 * cookie name stays a real constant (not gated on `IS_CLOUD` itself) so the
 * fulfill route's `IS_CLOUD` check is the only place that decides reachability.
 */
export const AWS_MP_TOKEN_COOKIE = "aws-mp-token";
