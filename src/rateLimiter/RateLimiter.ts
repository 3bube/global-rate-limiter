import type { RateLimitResult } from '../types';

/**
 * Contract every rate limiter implementation (and the fail-safe wrapper
 * around it) satisfies. Keeping this as an interface means the API layer
 * never depends on Redis directly -- it depends on this, which is what lets
 * FailSafeRateLimiter transparently substitute a fallback strategy.
 */
export interface RateLimiter {
  checkAndConsume(clientId: string, cost?: number): Promise<RateLimitResult>;
}
