import type { EventBus } from "../../services/event-bus";
import type { RedisLike } from "../clients/redis-client";

export interface RedisEventBusDeps {
  publisher: RedisLike;
  subscriber: RedisLike;
}

export type CreateRedisEventBus = (deps: RedisEventBusDeps) => EventBus;

/**
 * Cross-pod transcript fan-out over Redis pub/sub is dropped; the free
 * in-process bus serves the single api instance. Unreachable: the boot path
 * only constructs this when `hasRedisConfigured()` is true, which it never is.
 */
export const createRedisEventBus: CreateRedisEventBus = () => {
  throw new Error("The Redis event bus is not supported in this build");
};
