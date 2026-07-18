import type Redis from "ioredis";
import { ClientRegistry } from "../clients/clientRegistry";
import { RateLimiter } from "../rateLimiter/RateLimiter";
import { EventStreamRecorder } from "../logging/eventStream";
import type { Pool } from "pg";


export interface AppConfig {
  port: number;
  redisUrl: string;
  databaseUrl: string;
  circuitBreakerFailureThreshold: number;
  circuitBreakerResetTimeoutMs: number;
  redisCommandTimeoutMs: number;
  analyticsBatchSize: number;
  analyticsFlushIntervalMs: number;
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


export interface RouteDeps {
  limiter: RateLimiter;
  events: EventStreamRecorder;
  clients: ClientRegistry;
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
