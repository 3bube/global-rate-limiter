import Redis from 'ioredis';
import { RedisTokenBucketLimiter } from '../../src/rateLimiter/RedisTokenBucketLimiter';
import { FailSafeRateLimiter } from '../../src/rateLimiter/FailSafeRateLimiter';

/**
 * Points the limiter at a port nothing is listening on, to simulate Redis
 * being unreachable, and verifies the system fails open instead of
 * blocking traffic -- the core requirement from the brief.
 */
describe('FailSafeRateLimiter against an unreachable Redis (integration)', () => {
  it('keeps allowing requests instead of rejecting all traffic', async () => {
    const deadRedis = new Redis({
      host: '127.0.0.1',
      port: 65535, // nothing listens here
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });

    const primary = new RedisTokenBucketLimiter(deadRedis, {
      getConfig: async (clientId) => ({ clientId, limit: 10, windowSeconds: 60 }),
    });

    const failSafe = new FailSafeRateLimiter(primary, {
      failureThreshold: 2,
      resetTimeoutMs: 5000,
      commandTimeoutMs: 100,
    });

    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await failSafe.checkAndConsume('any-client'));
    }

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(results.every((r) => r.degraded)).toBe(true);

    await deadRedis.quit().catch(() => undefined);
  });
});
