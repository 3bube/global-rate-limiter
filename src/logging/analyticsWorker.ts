import { hostname } from 'node:os';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { createPool } from '../db/postgres';
import { config } from '../config';
import { logger } from '../logger';
import { USAGE_STREAM_KEY } from './eventStream';

export const GROUP = 'analytics-workers';
const CONSUMER = `${hostname()}-${process.pid}`;

/** How long an entry may sit unacked in another consumer's pending list
 *  before we assume that consumer died and claim the entry for ourselves. */
const CLAIM_MIN_IDLE_MS = 60_000;
/** How often to sweep for stale pending entries. */
const CLAIM_SWEEP_INTERVAL_MS = 30_000;

export interface StreamEntry {
  id: string;
  clientId: string;
  allowed: boolean;
  checkLatencyMs: number;
  timestamp: number;
}

/**
 * Background consumer: drains the Redis stream that the hot path writes to
 * and batch-inserts rows into Postgres. This is what "logged for analytics
 * without slowing down the rate limiter" actually means in practice --
 * the write cost is paid here, off the request path, and amortized across
 * a whole batch instead of one round trip per request.
 *
 * Uses a Redis consumer group so multiple worker instances can run for
 * throughput/HA without double-processing entries. Two failure modes are
 * covered explicitly:
 *
 *  - Worker dies AFTER XREADGROUP but BEFORE XACK: the entries sit in that
 *    consumer's pending list. claimStale() (XAUTOCLAIM) periodically adopts
 *    entries idle for over CLAIM_MIN_IDLE_MS so they are eventually
 *    written instead of being stranded forever.
 *  - Worker dies AFTER the Postgres INSERT but BEFORE XACK: the entries get
 *    redelivered and inserted again -- so the insert carries the unique
 *    stream entry id with ON CONFLICT DO NOTHING, making replays idempotent
 *    (no duplicate billing rows).
 */
export async function ensureGroup(redis: Redis, streamKey: string = USAGE_STREAM_KEY): Promise<void> {
  try {
    await redis.xgroup('CREATE', streamKey, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (err instanceof Error && err.message.includes('BUSYGROUP')) return;
    throw err;
  }
}

export function parseEntries(raw: [string, string[] | null][] | null): StreamEntry[] {
  if (!raw) return [];
  const entries: StreamEntry[] = [];
  for (const [id, fields] of raw) {
    // XAUTOCLAIM can surface entries whose payload was trimmed away
    // (MAXLEN) as a nil field list; there is nothing left to write for
    // those, so skip them (they still get ack'd via the normal flow).
    if (!fields) continue;
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const field = fields[i];
      const value = fields[i + 1];
      if (field !== undefined && value !== undefined) map.set(field, value);
    }
    entries.push({
      id,
      clientId: map.get('clientId') ?? 'unknown',
      allowed: map.get('allowed') === '1',
      checkLatencyMs: Number(map.get('checkLatencyMs') ?? 0),
      timestamp: Number(map.get('timestamp') ?? Date.now()),
    });
  }
  return entries;
}

export async function flush(
  pool: Pool,
  redis: Redis,
  entries: StreamEntry[],
  streamKey: string = USAGE_STREAM_KEY,
): Promise<void> {
  if (entries.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  entries.forEach((entry, i) => {
    const base = i * 5;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, to_timestamp($${base + 4} / 1000.0), $${base + 5})`,
    );
    params.push(entry.clientId, entry.allowed, entry.checkLatencyMs, entry.timestamp, entry.id);
  });

  // ON CONFLICT (stream_id) makes redelivery after a crash-before-ack a
  // no-op instead of a duplicate billing row.
  await pool.query(
    `INSERT INTO request_log (client_id, allowed, check_latency_ms, occurred_at, stream_id)
     VALUES ${values.join(', ')}
     ON CONFLICT (stream_id) DO NOTHING`,
    params,
  );

  await redis.xack(streamKey, GROUP, ...entries.map((e) => e.id));
}

/**
 * Adopt entries stuck in dead consumers' pending lists. Returns the claimed
 * entries so the caller can flush them through the normal path.
 */
export async function claimStale(
  redis: Redis,
  consumer: string,
  minIdleMs: number,
  streamKey: string = USAGE_STREAM_KEY,
): Promise<StreamEntry[]> {
  const claimed: StreamEntry[] = [];
  let cursor = '0-0';
  // XAUTOCLAIM pages through the pending list; loop until the cursor wraps.
  for (;;) {
    const response = (await redis.xautoclaim(
      streamKey, GROUP, consumer, minIdleMs, cursor, 'COUNT', 100,
    )) as [string, [string, string[] | null][], string[]?];
    claimed.push(...parseEntries(response[1]));
    cursor = response[0];
    if (cursor === '0-0') return claimed;
  }
}

export async function runWorker(signal: { stopped: boolean }): Promise<void> {
  const redis = new Redis(config.redisUrl);
  const pool = createPool(config.databaseUrl);
  await ensureGroup(redis);

  logger.info('Analytics worker started', { consumer: CONSUMER });

  let lastClaimSweep = 0;

  while (!signal.stopped) {
    try {
      if (Date.now() - lastClaimSweep >= CLAIM_SWEEP_INTERVAL_MS) {
        lastClaimSweep = Date.now();
        const stale = await claimStale(redis, CONSUMER, CLAIM_MIN_IDLE_MS);
        if (stale.length > 0) {
          logger.warn('Recovered stale pending entries', { count: stale.length });
          await flush(pool, redis, stale);
        }
      }

      const response = (await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', config.analyticsBatchSize,
        'BLOCK', config.analyticsFlushIntervalMs,
        'STREAMS', USAGE_STREAM_KEY, '>',
      )) as [string, [string, string[]][]][] | null;

      const entries = response ? parseEntries(response[0]?.[1] ?? null) : [];
      await flush(pool, redis, entries);
    } catch (err) {
      logger.error('Analytics batch failed, will retry', {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  await redis.quit();
  await pool.end();
}

if (require.main === module) {
  const signal = { stopped: false };
  process.on('SIGINT', () => { signal.stopped = true; });
  process.on('SIGTERM', () => { signal.stopped = true; });
  runWorker(signal).catch((err) => {
    logger.error('Analytics worker fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
