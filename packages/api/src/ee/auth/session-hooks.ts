import { onpremSessionHooks } from "../../lib/onprem-session-hooks";

/**
 * The cloud session hooks (Discord signup ping, welcome email, CloudFront
 * geo attributes, SSO JIT membership) are dropped. Every host in this build
 * is self-hosted, so the enterprise hooks ARE the self-hosted hooks.
 */
export const eeSessionHooks = onpremSessionHooks;
