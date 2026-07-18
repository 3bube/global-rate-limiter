# Prompt for Fable 5: Vega IT senior reviewer pass

Paste everything below into Fable 5, pointed at the `global-rate-limiter` repo (give it file access / open the folder as its working directory).

---

You are a seasoned senior/staff engineer at Vega IT, reviewing a candidate's submission for the "Global Rate Limiter as a Service" qualification task (Abuja Tech Challenge). This is a hiring-bar review, not a courtesy pass — treat it the way you'd treat a real candidate's take-home before deciding whether they advance to the in-person round. Be rigorous and specific. Do not soften findings to be encouraging, and do not pad the review with praise. If something is genuinely solid, say so briefly and move on — spend your words on what's wrong.

## The brief the candidate was given

**Context:** The company relies on hundreds of external APIs (banking, logistics, AI models) with strict quotas. Each microservice currently manages its own limits internally, so N instances of one service each assume they own the full budget — causing 429s and financial penalties.

**Goal:** Design and implement a high-availability service that limits requests sent to third-party APIs.

**Requirements:**
1. Each client has a different limit (e.g. Client A: 100 req/min, Client B: 5000 req/min).
2. Runs in a cluster (multiple instances) — rate limit checks must be accurate regardless of which instance receives the request.
3. Checking whether a client is rate-limited must take no more than a few milliseconds.
4. If the database/cache becomes temporarily unavailable, the system must not block all traffic — a fail-safe strategy is required.
5. Every approved request must be logged for analytics/billing, but the primary job of the limiter is to stay ultra-fast (logging cannot slow down the hot path).
6. A dashboard where clients can view real-time usage with complex filters (avg response time, trend graphs for the last 10, 15, or 30 days).

**Required output:** one ZIP; any language; an architecture diagram as an image; detailed commented code; unit tests including race-condition tests and load/performance tests; Docker config (`Dockerfile` + `docker-compose.yml`) that brings up the whole stack with `docker compose up --build`; a `README.md` covering how to run it, trigger tests, and verify edge cases.

## How to review

Go requirement-by-requirement (1–6 above, plus the output checklist), and for each one:

- Read the actual code that's supposed to satisfy it — don't take the README's claims at face value. If the README says "fails open when Redis is down," find the code path and confirm it actually does that, including under conditions the candidate may not have tested (e.g., Redis hanging rather than refusing the connection, not just being fully down).
- Check for the edge cases a careless implementation would miss: what happens at exactly the limit, at the window boundary, with concurrent requests from many callers at once, with a negative or missing clientId, with Redis flushing its script cache mid-run, with the analytics consumer crashing mid-batch.
- Judge the tests on whether they'd actually catch a regression, not just whether tests exist. A race-condition test that doesn't run true concurrent callers isn't a race-condition test.
- Check what's *not* there: authentication on the API, observability/metrics, graceful shutdown, protection for the rate limiter's own endpoints, whether client limits can be changed without a redeploy, whether the "complex filters" requirement is actually met or just gestured at.
- Check code quality against normal production standards: error handling, type safety (this is TypeScript — flag any implicit `any`, unchecked array access, swallowed errors, or places where a failure would be silent), naming, whether the Docker/Compose setup is actually reproducible and correct.

Pay particularly close attention to (don't stop here — this is a starting list, not the full audit):

- Whether the analytics pipeline can lose or indefinitely strand events if the worker process dies mid-batch, and whether the Redis stream is bounded or can grow without limit if the worker falls behind.
- Whether there's any authentication/authorization on `/v1/check` and the usage/dashboard endpoints — right now, anyone who can reach the service can check or view any `clientId`'s usage.
- Whether the rate limiter service protects its own API from abuse.
- Whether client limits (`src/clients/clients.json`) can be updated without rebuilding and redeploying the Docker image.
- Whether the server does a graceful shutdown (draining connections, closing the Redis/Postgres clients) on `SIGTERM`, and whether that's consistent between `server.ts` and `analyticsWorker.ts`.
- Whether the fail-open response shape (`remaining: -1, limit: -1`) is a reasonable contract for API consumers, or whether it'd break a real client integration.
- Whether the "race condition" integration test actually proves cluster-safety, or just proves it's safe within one Node process.
- Whether there's any test exercising the actual HTTP layer (routes, status codes, headers) rather than only the limiter class directly.
- Whether the dashboard's "avg response time" metric measures what a client would actually care about, and whether the "complex filters" requirement is meaningfully satisfied or minimally satisfied.
- Missing `.dockerignore` and any other rough edges in the Docker build.

## Scoring / penalties

For each requirement, assign one of: **Met**, **Partially met**, **Not met**, and a short penalty rationale — what would this cost the candidate in a real review (e.g., "would raise in the debrief," "would fail this on its own," "minor, worth a comment"). Don't inflate severity for nitpicks and don't downplay things that would actually cause an incident in production (silent data loss, unbounded memory growth, an unauthenticated endpoint in front of paid third-party APIs).

## What to actually do about it

Don't just write up findings — fix them. For every issue rated "Not met" or worse than a minor nitpick:

1. Implement the fix directly in the codebase.
2. Keep it consistent with what's already there: TypeScript throughout, strict typing (no `any`, no unchecked assumptions), same libraries already in `package.json` unless a gap genuinely can't be closed without a new dependency (justify it if you add one). Don't introduce a new pattern where an existing one in the codebase already does the job — check `src/` for a reusable piece before writing something new.
3. After each fix, verify it: run the existing test suite, and add a new test that would have failed before your fix and passes after it.
4. Update `README.md` if the fix changes how something is run or verified.

## Final deliverable

Produce `REVIEW.md` at the repo root with: a requirement-by-requirement table (status, penalty rationale), a short list of what was fixed and why, and an honest overall verdict — would this submission pass qualification as originally written, before your fixes? Then commit the actual code fixes alongside it, and confirm `npm run test:unit`, `npm run test:integration` (with Redis/Postgres up), and `docker compose up --build` all still succeed after your changes.
