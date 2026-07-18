import { hostname } from 'node:os';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { createPool } from '../db/postgres';
import { config } from '../config';
import { USAGE_STREAM_KEY } from './eventStream';

const GROUP = 'analytics-workers';
const CONSUMER = `${hostname()}-${process.pid}`;

interface StreamEntry {
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
 * throughput/HA without double-processing entries (each entry is
 * delivered to exactly one consumer in the group and only removed from
 * the pending list once XACK'd after a successful Postgres insert).
 */
async function ensureGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', USAGE_STREAM_KEY, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (err instanceof Error && err.message.includes('BUSYGROUP')) return;
    throw err;
  }
}

function parseEntries(raw: [string, string[]][] | null): StreamEntry[] {
  if (!raw) return [];
  return raw.map(([id, fields]) => {
    const map = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      map.set(fields[i] as string, fields[i + 1] as string);
    }
    return {
      id,
      clientId: map.get('clientId') ?? 'unknown',
      allowed: map.get('allowed') === '1',
      checkLatencyMs: Number(map.get('checkLatencyMs') ?? 0),
      timestamp: Number(map.get('timestamp') ?? Date.now()),
    };
  });
}

async function flush(pool: Pool, redis: Redis, entries: StreamEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  entries.forEach((entry, i) => {
    const base = i * 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, to_timestamp($${base + 4} / 1000.0))`);
    params.push(entry.clientId, entry.allowed, entry.checkLatencyMs, entry.timestamp);
  });

  await pool.query(
    `INSERT INTO request_log (client_id, allowed, check_latency_ms, occurred_at) VALUES ${values.join(', ')}`,
    params,
  );

  await redis.xack(USAGE_STREAM_KEY, GROUP, ...entries.map((e) => e.id));
}

export async function runWorker(signal: { stopped: boolean }): Promise<void> {
  const redis = new Redis(config.redisUrl);
  const pool = createPool(config.databaseUrl);
  await ensureGroup(redis);

  // eslint-disable-next-line no-console
  console.log(`[analyticsWorker] started as ${CONSUMER}`);

  while (!signal.stopped) {
    try {
      const response = (await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', config.analyticsBatchSize,
        'BLOCK', config.analyticsFlushIntervalMs,
        'STREAMS', USAGE_STREAM_KEY, '>',
      )) as [string, [string, string[]][]][] | null;

      const entries = response ? parseEntries(response[0]?.[1] ?? null) : [];
      await flush(pool, redis, entries);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[analyticsWorker] batch failed, will retry', err);
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
    // eslint-disable-next-line no-console
    console.error('[analyticsWorker] fatal', err);
    process.exit(1);
  });
}
