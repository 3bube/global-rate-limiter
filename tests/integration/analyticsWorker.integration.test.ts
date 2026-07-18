import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import { Pool } from 'pg';
import {
  ensureGroup,
  flush,
  claimStale,
  GROUP,
  type StreamEntry,
} from '../../src/logging/analyticsWorker';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://ratelimiter:ratelimiter@localhost:5432/ratelimiter';

/**
 * Exercises the two analytics failure modes the pipeline claims to survive,
 * against a real Redis and a real Postgres:
 *
 *  1. Worker dies after INSERT but before XACK -> the batch is redelivered
 *     and must NOT produce duplicate billing rows (stream_id idempotency).
 *  2. Worker dies after XREADGROUP but before XACK -> the entries sit in a
 *     dead consumer's pending list and must be claimable by another
 *     consumer (XAUTOCLAIM) instead of being stranded forever.
 */
describe('analytics worker durability (integration)', () => {
  let redis: Redis;
  let pool: Pool;
  const testRunId = `worker-test-${Date.now()}`;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    pool = new Pool({ connectionString: DATABASE_URL });

    const migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await pool.query(readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM request_log WHERE client_id LIKE $1', [`${testRunId}%`]);
    await redis.quit();
    await pool.end();
  });

  it('inserting the same batch twice produces no duplicate rows', async () => {
    const clientId = `${testRunId}-idempotent`;
    const now = Date.now();
    const entries: StreamEntry[] = [
      { id: `${now}-1`, clientId, allowed: true, checkLatencyMs: 1.2, timestamp: now },
      { id: `${now}-2`, clientId, allowed: false, checkLatencyMs: 0.8, timestamp: now },
    ];

    // Same batch flushed twice = exactly the redelivery-after-crash scenario.
    await flush(pool, redis, entries);
    await flush(pool, redis, entries);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM request_log WHERE client_id = $1',
      [clientId],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('entries stranded by a dead consumer are claimed and written by another consumer', async () => {
    const streamKey = `${testRunId}-stream`;
    const clientId = `${testRunId}-claim`;
    await ensureGroup(redis, streamKey);

    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await redis.xadd(
        streamKey, '*',
        'clientId', clientId,
        'allowed', '1',
        'checkLatencyMs', '1.0',
        'timestamp', String(now),
      );
    }

    // A consumer reads the batch and then "dies" without acking.
    await redis.xreadgroup('GROUP', GROUP, 'dead-consumer', 'COUNT', 10, 'STREAMS', streamKey, '>');

    // A healthy consumer sweeps the pending list (minIdle 0 so the test
    // does not have to wait out the production 60s threshold).
    const claimed = await claimStale(redis, 'recovery-consumer', 0, streamKey);
    expect(claimed).toHaveLength(3);
    expect(claimed.every((e) => e.clientId === clientId)).toBe(true);

    await flush(pool, redis, claimed, streamKey);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM request_log WHERE client_id = $1',
      [clientId],
    );
    expect(Number(rows[0]?.count)).toBe(3);

    // Nothing left stranded: the pending list is empty after the ack.
    const pending = (await redis.xpending(streamKey, GROUP)) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);

    await redis.del(streamKey);
  });
});
