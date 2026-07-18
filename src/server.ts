import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import Redis from 'ioredis';
import { config } from './config';
import { createPool } from './db/postgres';
import { ClientRegistry } from './clients/clientRegistry';
import { RedisTokenBucketLimiter } from './rateLimiter/RedisTokenBucketLimiter';
import { FailSafeRateLimiter } from './rateLimiter/FailSafeRateLimiter';
import { EventStreamRecorder } from './logging/eventStream';
import { registerRoutes } from './api/routes';
import { apiKeyAuth, selfRateLimit } from './api/auth';
import { logger } from './logger';

async function main(): Promise<void> {
  const redis = new Redis(config.redisUrl, {
    // Keep ioredis' own retry behavior bounded -- we don't want a single
    // stuck connection attempt to be the thing that violates our
    // millisecond latency budget instead of the circuit breaker.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on('error', (err) => {
    logger.error('Redis connection error', { error: err.message });
  });

  const pool = createPool(config.databaseUrl);
  const clients = new ClientRegistry();
  const events = new EventStreamRecorder(redis, config.analyticsStreamMaxLen);

  const primaryLimiter = new RedisTokenBucketLimiter(redis, clients);
  const limiter = new FailSafeRateLimiter(primaryLimiter, {
    failureThreshold: config.circuitBreakerFailureThreshold,
    resetTimeoutMs: config.circuitBreakerResetTimeoutMs,
    commandTimeoutMs: config.redisCommandTimeoutMs,
    // In-memory registry, so degraded responses still report the client's
    // real limit even while Redis is unreachable.
    fallbackConfig: clients,
    onDegraded: (clientId, reason) => {
      logger.warn('Rate limiter degraded', { clientId, reason });
    },
  });

  const app = Fastify({ logger: true });

  app.addHook('onRequest', selfRateLimit(config.selfIpLimitPerMinute));
  app.addHook('onRequest', apiKeyAuth(config.apiKey));

  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/dashboard/',
  });

  registerRoutes(app, { limiter, events, clients, redis, pool });

  // Drain in-flight requests and release connections on SIGTERM/SIGINT so
  // rolling deploys don't drop requests mid-flight (and so behavior matches
  // the analytics worker, which already handles both signals).
  let shuttingDown = false;
  const shutdown = (signalName: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal: signalName });
    void (async () => {
      try {
        await app.close();
        await redis.quit().catch(() => undefined);
        await pool.end();
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown', {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const address = await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info(`Server listening on ${address}`);
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err });
  process.exit(1);
});
