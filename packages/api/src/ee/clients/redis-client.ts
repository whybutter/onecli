/**
 * Redis is dropped (v2 migration decision 6: a single gateway/api instance is
 * the known ceiling). `hasRedisConfigured()` is the one read the free boot
 * path makes, and it is always false, so `getRedis()` is never reached.
 */
export interface RedisLike {
  duplicate(): RedisLike;
}

export const hasRedisConfigured = (): boolean => false;

export const getRedis = (): RedisLike => {
  throw new Error("Redis is not supported in this build");
};
