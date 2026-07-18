import Redis from 'ioredis';
import { RedisTokenBucketLimiter } from '../../src/rateLimiter/RedisTokenBucketLimiter';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * The whole point of doing the check-and-consume as a single Lua script is
 * that concurrent callers -- which is exactly what happens when N instances
 * of the service all receive requests for the same client around the same
 * moment -- can never both observe "tokens available" and both decide to
 * allow. This test proves that property by hammering the limiter with far
 * more concurrent requests than the limit allows, from what's effectively
 * multiple "instances" (multiple Redis connections), and asserting the
 * allowed count is exactly the limit -- not one more, not one less.
 */
describe('RedisTokenBucketLimiter under concurrency (integration)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('admits exactly `limit` requests when hit with many concurrent callers', async () => {
    const clientId = `race-${Date.now()}`;
    const limit = 10;
    const concurrency = 50;

    // Separate Redis connections to emulate separate service instances,
    // all racing against the same bucket key.
    const connections = Array.from({ length: concurrency }, () => new Redis(REDIS_URL));
    const limiters = connections.map(
      (connection) =>
        new RedisTokenBucketLimiter(connection, {
          getConfig: async () => ({ clientId, limit, windowSeconds: 60 }),
        }),
    );

    try {
      const results = await Promise.all(
        limiters.map((limiter) => limiter.checkAndConsume(clientId)),
      );

      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(limit);
    } finally {
      await Promise.all(connections.map((c) => c.quit()));
    }
  });
});
