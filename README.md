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

- Check a client:
  `curl -X POST localhost:3000/v1/check -H 'content-type: application/json' -H 'x-api-key: dev-api-key' -d '{"clientId":"client-a"}'`
- Dashboard: http://localhost:3000/dashboard/dashboard.html (enter the API key in the
  field at the top; it is sent as `x-api-key` on the dashboard's API calls)
- Health: http://localhost:3000/health (unauthenticated, for orchestrator probes)
- Client configs live in `src/clients/clients.json` (`client-a`: 100/min, `client-b`: 5000/min).

### Authentication

Every `/v1` endpoint requires an `x-api-key` header matching the `API_KEY` env var
(compose default: `dev-api-key`; override with `API_KEY=... docker compose up`).
Requests without it get `401`. Unknown `clientId`s get `404` instead of a default
bucket, so callers can't mint unbounded per-key state in Redis. The service also
applies a per-source-IP budget to its own API (`SELF_IP_LIMIT_PER_MINUTE`, default
600/min) so the limiter itself is not a free amplification target.

### Changing client limits at runtime

`src/clients/clients.json` is bind-mounted into the container. Edit it, then:

```bash
curl -X POST localhost:3000/v1/admin/clients/reload -H 'x-api-key: dev-api-key'
```

No image rebuild or restart required. The file is validated on load; a broken edit
leaves the previous limits in place.

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
  (covers: Redis error, Redis too slow, breaker OPEN skips the call entirely, and the
  degraded response reporting the client's real limit instead of `-1` sentinels).
- `tests/unit/routes.test.ts` — the actual HTTP layer via `fastify.inject`: auth
  (401), unknown client (404), allow (200 + headers), deny (429), degraded header,
  usage-query validation and filters, admin reload, self rate limiting.
- `tests/unit/eventStream.test.ts` — the hot-path recorder caps the stream with
  MAXLEN and swallows Redis failures without touching the request path.
- `tests/unit/clientRegistry.test.ts` — config validation, runtime reload, and
  reload keeping old state when the new file is invalid.
- `tests/integration/tokenBucket.integration.test.ts` — real Redis: limit enforcement,
  gradual refill, per-client isolation.
- `tests/integration/raceCondition.integration.test.ts` — **the race condition test**:
  fires 50 concurrent requests (each on its own Redis connection, simulating 50
  requests landing across many service instances at once) against a bucket with
  `limit=10`, and asserts *exactly* 10 are allowed. This is the test that proves the
  Lua script's atomicity actually holds under concurrency, not just in theory.
- `tests/integration/failSafe.integration.test.ts` — points the limiter at an
  unreachable Redis and asserts every request is still allowed (`degraded: true`).
- `tests/integration/analyticsWorker.integration.test.ts` — real Redis + Postgres:
  redelivering the same batch inserts no duplicate billing rows (stream_id
  idempotency), and entries stranded in a dead consumer's pending list are claimed
  via XAUTOCLAIM and written by another consumer.
- `tests/load/load-test.js` — k6 load test. Run with the stack up:
  `docker run --rm -i --network=host grafana/k6 run - < tests/load/load-test.js`
  (or `k6 run tests/load/load-test.js` if k6 is installed locally). Asserts p95 HTTP
  latency stays under 50ms and error rate under 1%.

## Verifying the edge cases manually

- **Fail-open on Redis outage**: `docker compose stop redis`, then keep hitting
  `POST /v1/check` — requests should keep returning `200` with an
  `X-RateLimit-Degraded: true` header (and the client's real configured limit in
  `X-RateLimit-Limit`, not a sentinel) instead of erroring out. `docker compose start
  redis` and it recovers automatically once the circuit breaker's `resetTimeoutMs`
  elapses.
- **Analytics survives a worker crash**: `docker compose stop analytics-worker`,
  send traffic (events accumulate in the capped Redis stream), then
  `docker compose start analytics-worker` — the backlog drains into Postgres, and
  entries a dead worker had read-but-not-acked are adopted via XAUTOCLAIM within
  ~60s. Duplicate delivery cannot double-bill (unique `stream_id`).
- **Graceful shutdown**: `docker compose stop app` sends SIGTERM; the server drains
  in-flight requests and closes its Redis/Postgres connections before exiting.
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
