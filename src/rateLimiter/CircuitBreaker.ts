import { CircuitState, CircuitBreakerOptions } from '../types';


/**
 * Minimal circuit breaker (CLOSED -> OPEN -> HALF_OPEN -> CLOSED).
 *
 * The point isn't just "catch the error" -- without this, every request
 * would still pay the full Redis connection timeout on every call while
 * Redis is down, which is far too slow for a service that must respond in
 * a few milliseconds. Tripping OPEN lets us fail fast (skip calling Redis
 * entirely) until a health-check trial call succeeds again.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(private readonly options: CircuitBreakerOptions) {}

  getState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.state = 'HALF_OPEN';
    }
    return this.state;
  }

  /** Call before attempting the protected operation. */
  canAttempt(): boolean {
    return this.getState() !== 'OPEN';
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}
