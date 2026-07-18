# Global Rate Limiter as a Service

A cluster-safe, high-availability rate limiter for third-party API calls, built for the
Vega IT Abuja Tech Challenge qualification task.

## Architecture (short version)

```
        ┌────────────┐      ┌─────────────┐
Client →│  App (N     │──1──▶│    Redis    │  token-bucket state (Lua, atomic)
        │  instances) │      │             │──2──▶ usage-events stream (XADD)
        └─────┬──────┘      └──────┬──────┘
              │                    │ 3 (XREADGROUP, batched)
              │                    ▼
              │             ┌─────────────┐
              └────4────────▶│  Postgres   │  request_log (analytics/billing)
           dashboard reads   └─────────────┘
```

1. Every instance runs the same atomic Lua script against the same Redis, so it doesn't
   matter which instance a request lands on — the bucket is shared, correct state.
2. The hot path fires a non-blocking `XADD` to a Redis stream after deciding
   allow/deny. It does not wait on Postgres.
3. A separate `analytics-worker` process drains the stream in batches and writes to
   Postgres, decoupling "billing-grade logging" from "must respond in a few ms".
4. The dashboard (`/dashboard/dashboard.html`) queries Postgres through the API for
   trend graphs and usage stats.

Full diagram: `docs/architecture.png`. Deeper explanation of *why* each piece is built
this way, plus what to read to understand it: `docs/LEARNING.md`.

## Run it

Requires Docker + Docker Compose.

```bash
docker compose up --build
```

This starts Redis, Postgres, the API (`app`, on port 3000, runs migrations on boot),
and the `analytics-worker`. Once up:

- Check a client: `curl -X POST localhost:3000/v1/check -H 'content-type: application/json' -d '{"clientId":"client-a"}'`
- Dashboard: http://localhost:3000/dashboard/dashboard.html
- Health: http://localhost:3000/health
- Client configs live in `src/clients/clients.json` (`client-a`: 100/min, `client-b`: 5000/min).

## Tests

```bash
npm install
docker compose up -d redis postgres   # dependencies for integration tests

npm run test:unit          # pure unit tests, no external services
npm run test:integration   # real Redis: token bucket behavior + concurrency
npm test                   # everything above
```

- `tests/unit/circuitBreaker.test.ts` — state machine transitions in isolation.
- `tests/unit/failSafeRateLimiter.test.ts` — fail-open behavior with a mocked limiter
  (covers: Redis error, Redis too slow, breaker OPEN skips the call entirely).
- `tests/integration/tokenBucket.integration.test.ts` — real Redis: limit enforcement,
  gradual refill, per-client isolation.
- `tests/integration/raceCondition.integration.test.ts` — **the race condition test**:
  fires 50 concurrent requests (each on its own Redis connection, simulating 50
  requests landing across many service instances at once) against a bucket with
  `limit=10`, and asserts *exactly* 10 are allowed. This is the test that proves the
  Lua script's atomicity actually holds under concurrency, not just in theory.
- `tests/integration/failSafe.integration.test.ts` — points the limiter at an
  unreachable Redis and asserts every request is still allowed (`degraded: true`).
- `tests/load/load-test.js` — k6 load test. Run with the stack up:
  `docker run --rm -i --network=host grafana/k6 run - < tests/load/load-test.js`
  (or `k6 run tests/load/load-test.js` if k6 is installed locally). Asserts p95 HTTP
  latency stays under 50ms and error rate under 1%.

## Verifying the edge cases manually

- **Fail-open on Redis outage**: `docker compose stop redis`, then keep hitting
  `POST /v1/check` — requests should keep returning `200` with an
  `X-RateLimit-Degraded: true` header instead of erroring out. `docker compose start
  redis` and it recovers automatically once the circuit breaker's `resetTimeoutMs`
  elapses.
- **Race safety across instances**: run `npm run test:integration` and read
  `raceCondition.integration.test.ts` — or scale the app for real with
  `docker compose up --build --scale app=3` behind a load balancer of your choice and
  hammer one client concurrently.
- **Burst vs. hard reset**: the token bucket refills continuously (see
  `src/rateLimiter/luaScripts/tokenBucket.lua`), so a client isn't handed a fresh full
  quota the instant a fixed window rolls over — check `tokenBucket.integration.test.ts`'s
  refill test.

## Project layout

```
src/
  rateLimiter/     token bucket (Redis + Lua), circuit breaker, fail-safe wrapper
  clients/         per-client limit config
  logging/         Redis stream writer (hot path) + batch Postgres worker
  db/              Postgres pool + migrations
  api/             Fastify routes + request/response schemas (zod)
  server.ts        wiring/composition root
public/
  dashboard.html   Chart.js usage dashboard
tests/
  unit/            no external dependencies
  integration/     require a real Redis (docker compose up -d redis postgres)
  load/            k6 script
docs/
  architecture.png / architecture.md
  LEARNING.md
```
