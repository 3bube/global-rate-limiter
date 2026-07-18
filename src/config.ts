import 'dotenv/config';
import type { AppConfig } from './types';

function readRequiredEnvString(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptionalEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}



export const config: AppConfig = {
  port: readOptionalEnvInt('PORT', 3000),
  redisUrl: readRequiredEnvString('REDIS_URL', 'redis://localhost:6379'),
  databaseUrl: readRequiredEnvString(
    'DATABASE_URL',
    'postgresql://ratelimiter:ratelimiter@localhost:5432/ratelimiter',
  ),
  // Shared secret for the /v1 API. The fallback exists so `npm run dev` works
  // out of the box; deployments must set a real value (docker-compose does).
  apiKey: readRequiredEnvString('API_KEY', 'dev-api-key'),
  circuitBreakerFailureThreshold: readOptionalEnvInt('CIRCUIT_BREAKER_FAILURE_THRESHOLD', 5),
  circuitBreakerResetTimeoutMs: readOptionalEnvInt('CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000),
  redisCommandTimeoutMs: readOptionalEnvInt('REDIS_COMMAND_TIMEOUT_MS', 75),
  analyticsBatchSize: readOptionalEnvInt('ANALYTICS_BATCH_SIZE', 200),
  analyticsFlushIntervalMs: readOptionalEnvInt('ANALYTICS_FLUSH_INTERVAL_MS', 1000),
  // Upper bound on the usage-events stream so a dead/slow worker can never
  // grow Redis without limit (which would eventually take the limiter down).
  analyticsStreamMaxLen: readOptionalEnvInt('ANALYTICS_STREAM_MAXLEN', 100_000),
  // How long an entry may sit unacked in a dead consumer's pending list
  // before another consumer claims it (XAUTOCLAIM) instead of it being
  // stranded forever.
  analyticsClaimMinIdleMs: readOptionalEnvInt('ANALYTICS_CLAIM_MIN_IDLE_MS', 60_000),
  // How often the worker sweeps for stale pending entries.
  analyticsClaimSweepIntervalMs: readOptionalEnvInt('ANALYTICS_CLAIM_SWEEP_INTERVAL_MS', 30_000),
  // Per-source-IP budget for the limiter's own API (self-protection).
  // Deliberately set well above the highest configured client limit
  // (client-b: 5000/min) -- this service expects to sit behind shared
  // egress (NAT/VPC/corporate proxy) for the N caller instances the brief
  // describes, so a low per-IP cap would throttle many legitimate callers
  // that merely share a source IP, not just a single abusive one.
  selfIpLimitPerMinute: readOptionalEnvInt('SELF_IP_LIMIT_PER_MINUTE', 20_000),
  // Window length for the self rate limit above, and how many distinct IPs
  // to track before pruning/resetting to keep the in-memory map bounded.
  selfRateLimitWindowMs: readOptionalEnvInt('SELF_RATE_LIMIT_WINDOW_MS', 60_000),
  selfRateLimitMaxTrackedIps: readOptionalEnvInt('SELF_RATE_LIMIT_MAX_TRACKED_IPS', 10_000),
};
