import type Redis from "ioredis";
import { EventStreamRecorder } from "../logging/eventStream";
import type { Pool } from "pg";


export interface AppConfig {
  port: number;
  redisUrl: string;
  databaseUrl: string;
  apiKey: string;
  circuitBreakerFailureThreshold: number;
  circuitBreakerResetTimeoutMs: number;
  redisCommandTimeoutMs: number;
  analyticsBatchSize: number;
  analyticsFlushIntervalMs: number;
  analyticsStreamMaxLen: number;
  analyticsClaimMinIdleMs: number;
  analyticsClaimSweepIntervalMs: number;
  selfIpLimitPerMinute: number;
  selfRateLimitWindowMs: number;
  selfRateLimitMaxTrackedIps: number;
}

export interface ClientLimitConfig {
  clientId: string; // identifier for the API consumer
  limit: number; // max requests allowed per window
  windowSeconds: number; // window length in seconds
}

export interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number; // tokens left in the bucket
  limit: number;
  resetAtMs: number; // epoch ms when the bucket will be full again
  degraded: boolean; // true when the result came from a fail safe fallback
}

/**
 * Contract every rate limiter implementation (and the fail-safe wrapper
 * around it) satisfies. Keeping this as an interface means the API layer
 * never depends on Redis directly -- it depends on this, which is what lets
 * FailSafeRateLimiter transparently substitute a fallback strategy.
 */
export interface RateLimiter {
  checkAndConsume(clientId: string, cost?: number): Promise<RateLimitResult>;
}

export interface UsageEvent {
  clientId: string; // identifier for the API consumer
  allowed: boolean;
  checkLatencyMs: number; // how long the rate limit check itself took
  timestamp: number;
}

export interface UsagePoint {
  bucket: string; // ISO date/hour bucket
  requestCount: number;
  allowedCount: number;
  deniedCount: number;
  avgLatencyMs: number;
}


/**
 * What the routes need from the client registry. An interface (rather than
 * the concrete ClientRegistry class) so HTTP-layer tests can substitute a
 * stub without touching the filesystem.
 */
export interface ClientDirectory {
  getConfig(clientId: string): Promise<ClientLimitConfig | undefined>;
  list(): ClientLimitConfig[];
  reload(): number;
}

export interface RouteDeps {
  limiter: RateLimiter;
  events: EventStreamRecorder;
  clients: ClientDirectory;
  redis: Redis;
  pool: Pool;
}


export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';


export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit trips OPEN. */
  failureThreshold: number;
  /** How long to stay OPEN before allowing a single trial call (HALF_OPEN). */
  resetTimeoutMs: number;
}
