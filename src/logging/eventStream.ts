import type { Redis } from 'ioredis';
import type { UsageEvent } from '../types';
import { logger } from '../logger';

export const USAGE_STREAM_KEY = 'usage-events';
export const DEFAULT_STREAM_MAXLEN = 100_000;

/**
 * Fire-and-forget event recorder.
 *
 * The rate-limit check itself must stay in the microsecond-to-low-single-
 * digit-millisecond range. Writing an analytics row synchronously on that
 * path -- especially to Postgres -- would dominate the latency budget. So
 * instead we do a single, cheap XADD (Redis is already in the request
 * path and is fast) and let a separate worker drain the stream into
 * Postgres in batches. If the XADD itself fails, we log and move on --
 * losing an analytics event is acceptable; blocking or rejecting the
 * client's actual request over it is not.
 *
 * The stream is capped with MAXLEN so that a crashed or lagging worker
 * degrades to bounded event loss instead of growing Redis without limit --
 * an unbounded stream would eventually OOM the same Redis that holds the
 * rate-limit state, taking the limiter itself down.
 */
export class EventStreamRecorder {
  constructor(
    private readonly redis: Redis,
    private readonly maxStreamLength: number = DEFAULT_STREAM_MAXLEN,
  ) {}

  record(event: UsageEvent): void {
    this.redis
      .xadd(
        USAGE_STREAM_KEY,
        'MAXLEN', '~', this.maxStreamLength,
        '*',
        'clientId', event.clientId,
        'allowed', event.allowed ? '1' : '0',
        'checkLatencyMs', String(event.checkLatencyMs),
        'timestamp', String(event.timestamp),
      )
      .catch((err: unknown) => {
        // Intentionally swallowed (after logging): analytics is
        // best-effort and must never affect the caller's response.
        logger.error('Failed to record usage event', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}
