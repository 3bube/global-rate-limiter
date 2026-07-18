import { FailSafeRateLimiter } from '../../src/rateLimiter/FailSafeRateLimiter';
import type { RateLimiter } from '../../src/rateLimiter/RateLimiter';
import type { RateLimitResult } from '../../src/types';

function okResult(): RateLimitResult {
  return { allowed: true, remainingTokens: 5, limit: 10, resetAtMs: Date.now() + 1000, degraded: false };
}

describe('FailSafeRateLimiter', () => {
  it('delegates to the primary limiter when healthy', async () => {
    const primary: RateLimiter = { checkAndConsume: jest.fn().mockResolvedValue(okResult()) };
    const failSafe = new FailSafeRateLimiter(primary, {
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      commandTimeoutMs: 50,
    });

    const result = await failSafe.checkAndConsume('client-a');
    expect(result.degraded).toBe(false);
    expect(result.allowed).toBe(true);
    expect(primary.checkAndConsume).toHaveBeenCalledWith('client-a', 1);
  });

  it('fails open when the primary limiter rejects', async () => {
    const primary: RateLimiter = {
      checkAndConsume: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const failSafe = new FailSafeRateLimiter(primary, {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      commandTimeoutMs: 50,
    });

    const result = await failSafe.checkAndConsume('client-a');
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('fails open when the primary limiter is slower than the timeout', async () => {
    const primary: RateLimiter = {
      checkAndConsume: jest.fn(
        () => new Promise((resolve) => setTimeout(() => resolve(okResult()), 200)),
      ),
    };
    const failSafe = new FailSafeRateLimiter(primary, {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      commandTimeoutMs: 20,
    });

    const result = await failSafe.checkAndConsume('client-a');
    expect(result.degraded).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it('reports the client\'s real limit in fail-open responses when a fallback config source is provided', async () => {
    const primary: RateLimiter = {
      checkAndConsume: jest.fn().mockRejectedValue(new Error('down')),
    };
    const failSafe = new FailSafeRateLimiter(primary, {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      commandTimeoutMs: 50,
      fallbackConfig: {
        getConfig: async () => ({ clientId: 'client-a', limit: 100, windowSeconds: 60 }),
      },
    });

    const before = Date.now();
    const result = await failSafe.checkAndConsume('client-a');
    expect(result.degraded).toBe(true);
    expect(result.allowed).toBe(true);
    // The degraded response must keep the normal contract shape: a consumer
    // parsing X-RateLimit-Remaining as an unsigned integer must never see -1.
    expect(result.limit).toBe(100);
    expect(result.remainingTokens).toBe(100);
    expect(result.resetAtMs).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('never returns negative sentinel values when failing open without a fallback', async () => {
    const primary: RateLimiter = {
      checkAndConsume: jest.fn().mockRejectedValue(new Error('down')),
    };
    const failSafe = new FailSafeRateLimiter(primary, {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      commandTimeoutMs: 50,
    });

    const result = await failSafe.checkAndConsume('client-a');
    expect(result.degraded).toBe(true);
    expect(result.remainingTokens).toBeGreaterThanOrEqual(0);
    expect(result.limit).toBeGreaterThanOrEqual(0);
  });

  it('short-circuits and skips the primary once the breaker is OPEN', async () => {
    const primary: RateLimiter = {
      checkAndConsume: jest.fn().mockRejectedValue(new Error('down')),
    };
    const failSafe = new FailSafeRateLimiter(primary, {
      failureThreshold: 1,
      resetTimeoutMs: 10_000,
      commandTimeoutMs: 50,
    });

    await failSafe.checkAndConsume('client-a'); // trips the breaker
    const callsBefore = (primary.checkAndConsume as jest.Mock).mock.calls.length;

    const result = await failSafe.checkAndConsume('client-a'); // should skip primary
    const callsAfter = (primary.checkAndConsume as jest.Mock).mock.calls.length;

    expect(result.degraded).toBe(true);
    expect(callsAfter).toBe(callsBefore); // primary was not called again
  });
});
