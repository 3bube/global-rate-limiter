import Redis from 'ioredis';
import { RedisTokenBucketLimiter, type ClientLimitLookup } from '../../src/rateLimiter/RedisTokenBucketLimiter';
import type { ClientLimitConfig } from '../../src/types';

/**
 * These tests talk to a *real* Redis (see README for how to start one via
 * docker compose). Mocking Redis for the Lua-script path would mean we
 * never actually exercise the atomicity guarantees we're relying on.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function fixedConfig(config: ClientLimitConfig): ClientLimitLookup {
  return { getConfig: async () => config };
}

describe('RedisTokenBucketLimiter (integration)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('allows requests up to the limit and denies the next one', async () => {
    const clientId = `test-${Date.now()}-a`;
    const limiter = new RedisTokenBucketLimiter(
      redis,
      fixedConfig({ clientId, limit: 5, windowSeconds: 60 }),
    );

    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await limiter.checkAndConsume(clientId));
    }

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(5);
    expect(results[5]?.allowed).toBe(false);
  });

  it('refills tokens gradually over time instead of resetting at a hard boundary', async () => {
    const clientId = `test-${Date.now()}-b`;
    // 10 tokens/second, so ~100ms should refill roughly 1 token.
    const limiter = new RedisTokenBucketLimiter(
      redis,
      fixedConfig({ clientId, limit: 10, windowSeconds: 1 }),
    );

    for (let i = 0; i < 10; i += 1) {
      await limiter.checkAndConsume(clientId);
    }
    const exhausted = await limiter.checkAndConsume(clientId);
    expect(exhausted.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const afterWait = await limiter.checkAndConsume(clientId);
    expect(afterWait.allowed).toBe(true);
  });

  it('gives independent budgets to different clients', async () => {
    const clientA = `test-${Date.now()}-c1`;
    const clientB = `test-${Date.now()}-c2`;
    const limiter = new RedisTokenBucketLimiter(redis, {
      getConfig: async (clientId) => ({ clientId, limit: 2, windowSeconds: 60 }),
    });

    await limiter.checkAndConsume(clientA);
    await limiter.checkAndConsume(clientA);
    const clientADenied = await limiter.checkAndConsume(clientA);
    const clientBAllowed = await limiter.checkAndConsume(clientB);

    expect(clientADenied.allowed).toBe(false);
    expect(clientBAllowed.allowed).toBe(true);
  });
});
