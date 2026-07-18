import Fastify, { type FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { registerRoutes } from '../../src/api/routes';
import { apiKeyAuth, selfRateLimit } from '../../src/api/auth';
import type { EventStreamRecorder } from '../../src/logging/eventStream';
import type { RateLimiter } from '../../src/rateLimiter/RateLimiter';
import type { ClientDirectory, ClientLimitConfig, RateLimitResult } from '../../src/types';

const API_KEY = 'test-key';

function okResult(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return {
    allowed: true,
    remainingTokens: 9,
    limit: 10,
    resetAtMs: 1_700_000_000_000,
    degraded: false,
    ...overrides,
  };
}

interface TestDeps {
  limiter: RateLimiter;
  recordFn: jest.Mock;
  queryFn: jest.Mock;
  clients: ClientDirectory;
}

function makeDeps(result: RateLimitResult = okResult()): TestDeps {
  const known: ClientLimitConfig = { clientId: 'client-a', limit: 10, windowSeconds: 60 };
  const recordFn = jest.fn();
  const queryFn = jest.fn().mockResolvedValue({ rows: [] });
  return {
    limiter: { checkAndConsume: jest.fn().mockResolvedValue(result) },
    recordFn,
    queryFn,
    clients: {
      getConfig: async (clientId) => (clientId === known.clientId ? known : undefined),
      list: () => [known],
      reload: jest.fn().mockReturnValue(1) as unknown as () => number,
    },
  };
}

function buildApp(deps: TestDeps, selfLimitPerMinute = 1000): FastifyInstance {
  const app = Fastify();
  app.addHook('onRequest', selfRateLimit({ limitPerMinute: selfLimitPerMinute }));
  app.addHook('onRequest', apiKeyAuth(API_KEY));
  registerRoutes(app, {
    limiter: deps.limiter,
    events: { record: deps.recordFn } as unknown as EventStreamRecorder,
    clients: deps.clients,
    redis: { ping: jest.fn().mockResolvedValue('PONG') } as unknown as Redis,
    pool: { query: deps.queryFn } as unknown as Pool,
  });
  return app;
}

describe('HTTP API', () => {
  it('rejects /v1 requests without the API key', async () => {
    const app = buildApp(makeDeps());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      payload: { clientId: 'client-a' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('leaves /health reachable without the API key', async () => {
    const app = buildApp(makeDeps());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for a clientId that is not registered', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'x-api-key': API_KEY },
      payload: { clientId: 'made-up-client' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'unknown_client', clientId: 'made-up-client' });
    expect(deps.limiter.checkAndConsume).not.toHaveBeenCalled();
    expect(deps.recordFn).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed body', async () => {
    const app = buildApp(makeDeps());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'x-api-key': API_KEY },
      payload: { cost: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('returns 200 with rate limit headers when allowed', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'x-api-key': API_KEY },
      payload: { clientId: 'client-a' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
    expect(res.headers['x-ratelimit-reset']).toBe('1700000000000');
    expect(res.headers['x-ratelimit-degraded']).toBeUndefined();
    expect(deps.recordFn).toHaveBeenCalledTimes(1);
  });

  it('returns 429 when the limiter denies', async () => {
    const app = buildApp(makeDeps(okResult({ allowed: false, remainingTokens: 0 })));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'x-api-key': API_KEY },
      payload: { clientId: 'client-a' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('flags degraded results via the X-RateLimit-Degraded header', async () => {
    const app = buildApp(makeDeps(okResult({ degraded: true })));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'x-api-key': API_KEY },
      payload: { clientId: 'client-a' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-degraded']).toBe('true');
  });

  it('rejects a usage query outside the allowed range', async () => {
    const app = buildApp(makeDeps());
    const res = await app.inject({
      method: 'GET',
      url: '/v1/clients/client-a/usage?days=99',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts granularity and outcome filters on the usage query', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/clients/client-a/usage?days=10&granularity=hour&outcome=denied',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ clientId: 'client-a', granularity: 'hour', outcome: 'denied' });
    const [sql, params] = deps.queryFn.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("date_trunc('hour'");
    expect(sql).toContain('AND NOT allowed');
    expect(params).toEqual(['client-a', 10]);
  });

  it('reloads the client registry via the admin endpoint', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/clients/reload',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reloaded: 1 });
  });

  it('rate-limits its own API per source IP', async () => {
    const app = buildApp(makeDeps(), 2);
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/v1/check',
        headers: { 'x-api-key': API_KEY },
        payload: { clientId: 'client-a' },
      });

    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(200);
    const third = await request();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: 'self_rate_limited' });
  });
});
