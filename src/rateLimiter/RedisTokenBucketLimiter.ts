import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Redis } from 'ioredis';
import type { RateLimiter } from './RateLimiter';
import type { ClientLimitConfig, RateLimitResult } from '../types';

const SCRIPT_PATH = path.join(__dirname, 'luaScripts', 'tokenBucket.lua');

export interface ClientLimitLookup {
  getConfig(clientId: string): Promise<ClientLimitConfig | undefined>;
}

/**
 * Cluster-safe token-bucket rate limiter backed by Redis.
 *
 * "Cluster-safe" here means: 10 instances of this service, all pointed at
 * the same Redis, will agree on exactly how many requests a client has
 * left, because the state (tokens remaining) lives in Redis, not in any
 * instance's memory, and the read-modify-write happens atomically via a
 * Lua script (see tokenBucket.lua).
 */
export class RedisTokenBucketLimiter implements RateLimiter {
  private readonly scriptSource: string;
  private shaCache: string | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly clients: ClientLimitLookup,
    private readonly defaultConfig: ClientLimitConfig = {
      clientId: 'default',
      limit: 60,
      windowSeconds: 60,
    },
  ) {
    this.scriptSource = readFileSync(SCRIPT_PATH, 'utf8');
  }

  async checkAndConsume(clientId: string, cost = 1): Promise<RateLimitResult> {
    const config = (await this.clients.getConfig(clientId)) ?? {
      ...this.defaultConfig,
      clientId,
    };

    const refillPerMs = config.limit / (config.windowSeconds * 1000);
    const now = Date.now();
    const key = `bucket:{${clientId}}`;

    const sha = await this.ensureScriptLoaded();

    let raw: [number, string, number];
    try {
      raw = (await this.redis.evalsha(
        sha,
        1,
        key,
        config.limit,
        refillPerMs,
        now,
        cost,
      )) as [number, string, number];
    } catch (err) {
      // EVALSHA fails with NOSCRIPT if Redis restarted/flushed its script
      // cache since we last loaded it. Reload once and retry rather than
      // surfacing a spurious failure to the caller.
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        this.shaCache = undefined;
        const retrySha = await this.ensureScriptLoaded();
        raw = (await this.redis.evalsha(
          retrySha,
          1,
          key,
          config.limit,
          refillPerMs,
          now,
          cost,
        )) as [number, string, number];
      } else {
        throw err;
      }
    }

    const [allowedFlag, remainingStr, resetAtMs] = raw;

    return {
      allowed: allowedFlag === 1,
      remainingTokens: Math.max(0, Math.floor(Number(remainingStr))),
      limit: config.limit,
      resetAtMs,
      degraded: false,
    };
  }

  private async ensureScriptLoaded(): Promise<string> {
    if (this.shaCache) return this.shaCache;
    this.shaCache = await this.redis.script('LOAD', this.scriptSource) as string;
    return this.shaCache;
  }
}
