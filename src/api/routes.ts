import type { FastifyInstance } from 'fastify';
import type { UsagePoint, RouteDeps } from '../types';
import { checkRequestSchema, usageQuerySchema } from '../schemas';
import { logger } from '../logger';

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { limiter, events, clients, redis, pool } = deps;

  app.get('/health', async (_req, reply) => {
    const checks = { redis: false, postgres: false };
    try {
      await redis.ping();
      checks.redis = true;
    } catch {
      /* reported via checks.redis */
    }
    try {
      await pool.query('SELECT 1');
      checks.postgres = true;
    } catch {
      /* reported via checks.postgres */
    }
    const healthy = checks.redis && checks.postgres;
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', checks };
  });

  app.get('/v1/clients', async () => {
    return { clients: clients.list() };
  });

  // Re-reads clients.json so limits can be changed at runtime (edit the
  // mounted file, then hit this) instead of requiring an image rebuild.
  app.post('/v1/admin/clients/reload', async () => {
    const count = clients.reload();
    logger.info('Client registry reloaded', { count });
    return { reloaded: count };
  });

  app.post('/v1/check', async (req, reply) => {
    const parsed = checkRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_request', details: parsed.error.flatten() };
    }

    const { clientId, cost } = parsed.data;

    // Unknown clients are rejected outright. Handing out a default bucket
    // to any string a caller invents would let one misbehaving caller
    // create unbounded per-key state in Redis and sidestep onboarding.
    if ((await clients.getConfig(clientId)) === undefined) {
      reply.code(404);
      return { error: 'unknown_client', clientId };
    }

    const started = performance.now();
    const result = await limiter.checkAndConsume(clientId, cost ?? 1);
    const checkLatencyMs = performance.now() - started;

    events.record({
      clientId,
      allowed: result.allowed,
      checkLatencyMs,
      timestamp: Date.now(),
    });

    reply.header('X-RateLimit-Limit', String(result.limit));
    reply.header('X-RateLimit-Remaining', String(result.remainingTokens));
    reply.header('X-RateLimit-Reset', String(result.resetAtMs));
    if (result.degraded) reply.header('X-RateLimit-Degraded', 'true');

    reply.code(result.allowed ? 200 : 429);
    return result;
  });

  app.get<{ Params: { clientId: string } }>('/v1/clients/:clientId/usage', async (req, reply) => {
    const parsedQuery = usageQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      reply.code(400);
      return { error: 'invalid_query', details: parsedQuery.error.flatten() };
    }
    const { clientId } = req.params;
    const { days, granularity, outcome } = parsedQuery.data;

    // `granularity` is interpolated, not parameterized, because Postgres
    // does not accept a bind parameter there — safe because zod has already
    // constrained it to the enum 'day' | 'hour'.
    const bucketFormat = granularity === 'hour' ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD';
    const outcomeFilter =
      outcome === 'allowed' ? 'AND allowed' : outcome === 'denied' ? 'AND NOT allowed' : '';

    const { rows } = await pool.query<{
      bucket: string;
      request_count: string;
      allowed_count: string;
      denied_count: string;
      avg_latency_ms: string;
    }>(
      `
      SELECT
        to_char(date_trunc('${granularity}', occurred_at), '${bucketFormat}') AS bucket,
        COUNT(*) AS request_count,
        COUNT(*) FILTER (WHERE allowed) AS allowed_count,
        COUNT(*) FILTER (WHERE NOT allowed) AS denied_count,
        COALESCE(AVG(check_latency_ms), 0) AS avg_latency_ms
      FROM request_log
      WHERE client_id = $1 AND occurred_at >= now() - ($2 || ' days')::interval
        ${outcomeFilter}
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [clientId, days],
    );

    const points: UsagePoint[] = rows.map((r) => ({
      bucket: r.bucket,
      requestCount: Number(r.request_count),
      allowedCount: Number(r.allowed_count),
      deniedCount: Number(r.denied_count),
      avgLatencyMs: Number(r.avg_latency_ms),
    }));

    return { clientId, days, granularity, outcome, points };
  });
}
