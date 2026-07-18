import 'dotenv/config';
import type { AppConfig } from './types';

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}



export const config: AppConfig = {
  port: intEnv('PORT', 3000),
  redisUrl: requireEnv('REDIS_URL', 'redis://localhost:6379'),
  databaseUrl: requireEnv(
    'DATABASE_URL',
    'postgresql://ratelimiter:ratelimiter@localhost:5432/ratelimiter',
  ),
  // Shared secret for the /v1 API. The fallback exists so `npm run dev` works
  // out of the box; deployments must set a real value (docker-compose does).
  apiKey: requireEnv('API_KEY', 'dev-api-key'),
  circuitBreakerFailureThreshold: intEnv('CIRCUIT_BREAKER_FAILURE_THRESHOLD', 5),
  circuitBreakerResetTimeoutMs: intEnv('CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000),
  redisCommandTimeoutMs: intEnv('REDIS_COMMAND_TIMEOUT_MS', 75),
  analyticsBatchSize: intEnv('ANALYTICS_BATCH_SIZE', 200),
  analyticsFlushIntervalMs: intEnv('ANALYTICS_FLUSH_INTERVAL_MS', 1000),
  // Upper bound on the usage-events stream so a dead/slow worker can never
  // grow Redis without limit (which would eventually take the limiter down).
  analyticsStreamMaxLen: intEnv('ANALYTICS_STREAM_MAXLEN', 100_000),
  // Per-source-IP budget for the limiter's own API (self-protection).
  selfIpLimitPerMinute: intEnv('SELF_IP_LIMIT_PER_MINUTE', 600),
};
