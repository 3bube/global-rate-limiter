import type { Redis } from 'ioredis';
import type { UsageEvent } from '../types';

export const USAGE_STREAM_KEY = 'usage-events';

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
 */
export class EventStreamRecorder {
  constructor(private readonly redis: Redis) {}

  record(event: UsageEvent): void {
    this.redis
      .xadd(
        USAGE_STREAM_KEY,
        '*',
        'clientId', event.clientId,
        'allowed', event.allowed ? '1' : '0',
        'checkLatencyMs', String(event.checkLatencyMs),
        'timestamp', String(event.timestamp),
      )
      .catch((err) => {
        // Intentionally swallowed (after logging): analytics is
        // best-effort and must never affect the caller's response.
        // eslint-disable-next-line no-console
        console.error('[eventStream] failed to record usage event', err);
      });
  }
}
