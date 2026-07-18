# Learning guide: what this project is actually teaching you

This scaffold isn't just code to submit — every piece maps to a concept worth
understanding on its own. Here's the order I'd learn them in, tied to the exact file
that demonstrates each one.

## 1. Why per-instance rate limiting breaks (the problem statement)

The task's context paragraph is the whole reason this is hard: if each of 10
microservice instances thinks it owns the full quota, you get 10x the actual limit.
The fix is always the same shape: move the *state* (how many requests are left) out of
each instance's memory and into something all instances share — here, Redis.

Read: nothing to build yet, just internalize this. It's the reason every other
decision in this project exists.

## 2. Rate limiting algorithms

There are five you'll see referenced everywhere; know the trade-offs, not just the
names:

- **Fixed window** — count resets at a clock boundary (e.g. every minute at :00).
  Simple, but allows 2x burst right at the boundary (100 requests at 0:59, another
  100 at 1:00).
- **Sliding window log** — store a timestamp per request, count how many fall in the
  last N seconds. Perfectly accurate, but memory grows with request volume.
- **Sliding window counter** — approximates the sliding log with two fixed windows
  and a weighted average. Cheap, close enough for most cases.
- **Token bucket** — a bucket holds up to `capacity` tokens, refills continuously at
  `rate` tokens/sec, each request costs 1+ tokens. **This is what's implemented here**
  (`src/rateLimiter/luaScripts/tokenBucket.lua`) — it avoids the fixed-window burst
  problem because refill is continuous, and storage is O(1) per client (two numbers:
  tokens, last-refill-time).
- **Leaky bucket** — same idea inverted: requests queue and drain at a constant rate.
  Better when you want to *smooth* traffic to a downstream system rather than just cap
  it.

Why it matters for this task specifically: the brief says "checking must not take
longer than a few ms" — token bucket's O(1) storage is part of why that's achievable.

## 3. Redis fundamentals

- **Data structures used here**: a `HASH` per client (`tokens`, `ts` fields) for the
  bucket, and a `STREAM` (`usage-events`) for the event log. Read up on both —
  streams in particular (`XADD`, `XREADGROUP`, consumer groups) are less commonly
  taught than the basic string/hash/list types but are exactly the right tool for
  "many producers, need at-least-once delivery to a batch consumer."
- **Why Lua scripting**: Redis is single-threaded per command, and a Lua script
  submitted via `EVAL`/`EVALSHA` runs as *one* atomic unit — no other command can
  interleave partway through it. That's what makes `tokenBucket.lua` race-free: two
  instances calling it "simultaneously" are actually serialized by Redis itself. This
  is the concept `tests/integration/raceCondition.integration.test.ts` proves.
  Contrast this with doing `GET` then `SET` from application code — between those two
  calls, another process can slip in and read the same stale value (a classic
  check-then-act race condition).

Read: Redis docs on [Scripting with Lua](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
and [Streams](https://redis.io/docs/latest/develop/data-types/streams/).

## 4. Distributed systems: failure handling

- **Fail-open vs. fail-closed**: when your dependency (Redis) is down, do you let
  traffic through unchecked (fail-open) or block everything (fail-closed)? This
  project fails open (`FailSafeRateLimiter.ts`) because the business cost of a
  temporary over-admission is judged lower than blocking all traffic to every
  downstream API. This is a *judgment call*, not a universal rule — a fraud-check
  service would likely fail closed instead. Be able to argue both sides; a reviewer
  may ask why you picked the one you did.
- **Circuit breaker pattern**: don't just catch errors — once a dependency is clearly
  down, stop calling it for a while (fail fast) instead of paying a timeout on every
  single request. `CircuitBreaker.ts` implements the classic three-state machine
  (CLOSED → OPEN → HALF_OPEN). Martin Fowler's write-up on this pattern is the
  standard reference: search "Martin Fowler CircuitBreaker."
- **Timeouts as a first-class design decision**: every external call in this project
  (`FailSafeRateLimiter.withTimeout`) has an explicit timeout. Without one, "Redis is
  slow" and "Redis is down" look identical to your caller and both violate the
  latency budget.

## 5. Decoupling the hot path from slow work

`EventStreamRecorder.record()` never `await`s inside the request handler in a way
that blocks the response — it's fire-and-forget. The actual Postgres write happens in
`analyticsWorker.ts`, a separate process, batched. This is a general pattern worth
understanding beyond this project: **anything that isn't required to produce the
response should happen off the request path.** Read up on message queues generally
(Redis Streams here; Kafka, SQS, RabbitMQ are the same idea at different scales) and
on "consumer groups" specifically, since that's what lets you run multiple worker
instances without double-processing the same event.

## 6. Testing concurrent/distributed code

Unit tests with mocks (`tests/unit/`) are necessary but not sufficient here — they
can't prove the atomicity claim. `tests/integration/raceCondition.integration.test.ts`
is the interesting one: it fires 50 truly concurrent requests (each over its own Redis
connection) at a bucket with room for 10, and asserts *exactly* 10 succeed. That's how
you test a race condition: don't assert "no errors happened," assert an exact,
falsifiable count that would be wrong if the race existed.

Also worth understanding: **load testing** (`tests/load/load-test.js`, using
[k6](https://k6.io/docs/)) is a different discipline from correctness testing — it's
asking "does this stay fast and stable under sustained concurrent traffic," not "is
this logically correct." Both are asked for in the brief for a reason.

## 7. TypeScript patterns used here

- Interfaces as seams for substitutability (`RateLimiter`, `ClientLimitLookup`) — this
  is what lets `FailSafeRateLimiter` wrap `RedisTokenBucketLimiter` without knowing
  anything about Redis, and what makes both trivially mockable in unit tests.
  General principle: depend on interfaces, not concrete classes, at your architectural
  boundaries.
- `strict: true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` in
  `tsconfig.json` — these catch a lot of real bugs (e.g. forgetting an array access
  could be `undefined`) that plain `strict` mode alone lets through. Worth reading the
  TypeScript handbook's compiler options reference to understand what each one buys
  you.
- `zod` schemas (`src/api/schemas.ts`) validate untrusted input (the request body) at
  the boundary and produce a typed result — this is the "parse, don't validate"
  pattern, worth reading about by that name.

## 8. Docker & orchestration

- Multi-stage `Dockerfile` (build stage compiles TypeScript, runtime stage only ships
  the compiled output + prod dependencies) — smaller final image, no dev tooling in
  production.
- `docker-compose.yml` `depends_on: condition: service_healthy` — makes sure the app
  doesn't start (and run migrations) before Postgres/Redis are actually ready to
  accept connections, not just "container started."

## Suggested order if you're learning from scratch

1. Token bucket algorithm (pen and paper — simulate it by hand for a few requests).
2. Redis basics (strings, hashes) then Lua scripting, then streams.
3. Circuit breaker pattern + fail-open/fail-closed trade-offs.
4. Write the race-condition test yourself against a *naive* (non-atomic) limiter
   first, watch it fail, then fix it with the Lua script and watch it pass. That
   contrast is the fastest way to internalize why atomicity matters.
5. Docker Compose basics if you haven't used it before.
6. k6 or any load testing tool, just enough to read a p95 latency number.
