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
  const events = new EventStreamRecorder(redis);

  const primaryLimiter = new RedisTokenBucketLimiter(redis, clients);
  const limiter = new FailSafeRateLimiter(primaryLimiter, {
    failureThreshold: config.circuitBreakerFailureThreshold,
    resetTimeoutMs: config.circuitBreakerResetTimeoutMs,
    commandTimeoutMs: config.redisCommandTimeoutMs,
    onDegraded: (clientId, reason) => {
      logger.warn('Rate limiter degraded', { clientId, reason });
    },
  });

  const app = Fastify({ logger: true });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/dashboard/',
  });

  registerRoutes(app, { limiter, events, clients, redis, pool });

  const address = await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info(`Server listening on ${address}`);
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err });
  process.exit(1);
});
