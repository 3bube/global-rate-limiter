import type { FastifyReply, FastifyRequest } from 'fastify';

type OnRequestHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Shared-secret authentication for the /v1 API.
 *
 * Without this, anyone who can reach the service can consume any client's
 * quota (every /v1/check call spends a token) or read any client's usage
 * data — unacceptable for a service that fronts paid third-party APIs.
 * /health stays open for orchestrator probes and the dashboard's static
 * files stay open (the dashboard itself sends the key on its API calls).
 */
export function apiKeyAuth(apiKey: string): OnRequestHook {
  return async (req, reply) => {
    if (!req.url.startsWith('/v1')) return;
    if (req.headers['x-api-key'] !== apiKey) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

export interface SelfRateLimitOptions {
  limitPerMinute: number;
  /** Window length in ms. Defaults to 60s to match "per minute". */
  windowMs?: number;
  /** How many distinct IPs to track before pruning/resetting the map. */
  maxTrackedIps?: number;
}

/**
 * Fixed-window per-IP budget for the limiter's own endpoints, so the rate
 * limiter is not itself a free amplification target. Deliberately in-memory
 * and per-instance: this is abuse protection for *this* process, not the
 * shared client-quota accounting (which lives in Redis).
 */
export function selfRateLimit(options: SelfRateLimitOptions): OnRequestHook {
  const { limitPerMinute, windowMs = 60_000, maxTrackedIps = 10_000 } = options;
  const windows = new Map<string, { count: number; windowStart: number }>();

  return async (req, reply) => {
    if (!req.url.startsWith('/v1')) return;

    const now = Date.now();
    const entry = windows.get(req.ip);
    if (!entry || now - entry.windowStart >= windowMs) {
      // Bound memory before inserting a fresh window: drop expired entries,
      // and if a flood of unique IPs is still over the cap, reset entirely
      // rather than grow without limit.
      if (windows.size >= maxTrackedIps) {
        for (const [ip, w] of windows) {
          if (now - w.windowStart >= windowMs) windows.delete(ip);
        }
        if (windows.size >= maxTrackedIps) windows.clear();
      }
      windows.set(req.ip, { count: 1, windowStart: now });
      return;
    }

    entry.count += 1;
    if (entry.count > limitPerMinute) {
      reply.code(429).send({ error: 'self_rate_limited' });
    }
  };
}
