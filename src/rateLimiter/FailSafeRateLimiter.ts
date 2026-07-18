import type { RateLimiter } from './RateLimiter';
import type { ClientLimitConfig, RateLimitResult, CircuitBreakerOptions } from '../types';
import { CircuitBreaker } from './CircuitBreaker';

export interface FailSafeOptions extends CircuitBreakerOptions {
  /** Hard timeout for a single Redis round trip before we treat it as a failure. */
  commandTimeoutMs: number;
  onDegraded?: (clientId: string, reason: string) => void;
}

/**
 * Wraps a RateLimiter so that Redis being slow or unavailable can never
 * block traffic. This is the fail-safe strategy the task requires:
 *
 *  - CLOSED / HALF_OPEN: call Redis, bounded by commandTimeoutMs.
 *  - OPEN: skip Redis entirely and fail OPEN (allow the request), because
 *    for this system the cost of over-admitting a few requests during an
 *    outage is lower than the cost of rejecting all traffic to every
 *    downstream API. That's a deliberate business trade-off, not an
 *    oversight -- a payments-authorization limiter might choose the
 *    opposite (fail closed) for the same pattern.
 *
 * Every degraded decision is flagged (`degraded: true`) so callers can
 * still see, downstream, that the number wasn't actually enforced.
 */
export class FailSafeRateLimiter implements RateLimiter {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly primary: RateLimiter,
    private readonly options: FailSafeOptions,
  ) {
    this.breaker = new CircuitBreaker({
      failureThreshold: options.failureThreshold,
      resetTimeoutMs: options.resetTimeoutMs,
    });
  }

  async checkAndConsume(clientId: string, cost = 1): Promise<RateLimitResult> {
    if (!this.breaker.canAttempt()) {
      this.options.onDegraded?.(clientId, 'circuit_open');
      return this.failOpen(clientId, cost);
    }

    try {
      const result = await this.withTimeout(
        this.primary.checkAndConsume(clientId, cost),
        this.options.commandTimeoutMs,
      );
      this.breaker.onSuccess();
      return result;
    } catch (err) {
      this.breaker.onFailure();
      this.options.onDegraded?.(
        clientId,
        err instanceof Error ? err.message : 'unknown_error',
      );
      return this.failOpen(clientId, cost);
    }
  }

  private failOpen(clientId: string, cost: number): RateLimitResult {
    // We can't know the real remaining count without Redis, so we report a
    // conservative placeholder and rely on `degraded: true` to signal that
    // this number is not authoritative.
    void clientId;
    void cost;
    return {
      allowed: true,
      remainingTokens: -1,
      limit: -1,
      resetAtMs: Date.now(),
      degraded: true,
    };
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('redis_timeout')), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

export type { ClientLimitConfig };
