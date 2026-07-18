import { CircuitBreaker } from '../../src/rateLimiter/CircuitBreaker';

describe('CircuitBreaker', () => {
  it('stays CLOSED under the failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.canAttempt()).toBe(true);
  });

  it('trips OPEN once the failure threshold is reached', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
    expect(cb.canAttempt()).toBe(false);
  });

  it('moves to HALF_OPEN after resetTimeoutMs and closes again on success', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');

    await new Promise((r) => setTimeout(r, 30));
    expect(cb.getState()).toBe('HALF_OPEN');

    cb.onSuccess();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('re-opens immediately on a failed HALF_OPEN trial', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
    cb.onFailure();
    await new Promise((r) => setTimeout(r, 30));
    expect(cb.getState()).toBe('HALF_OPEN');

    cb.onFailure();
    expect(cb.getState()).toBe('OPEN');
  });
});
