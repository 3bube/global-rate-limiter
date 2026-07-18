// k6 load/performance test for POST /v1/check.
//
// Run (with the stack up via docker compose):
//   docker run --rm -i --network=host grafana/k6 run - < tests/load/load-test.js
// or, if k6 is installed locally:
//   BASE_URL=http://localhost:3000 k6 run tests/load/load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'dev-api-key';
const CLIENTS = ['client-a', 'client-b'];

// k6's http_req_failed metric defaults to "any status >= 400 is a failure."
// For a rate limiter, 429 is the *correct* response once a client is over
// quota -- with client-a capped at 100/min and 50 VUs hammering it, most
// 429s here are the limiter working as designed, not an error. Marking 200
// and 429 as both "expected" keeps http_req_failed meaningful: it now only
// trips on real failures (5xx, connection errors, timeouts).
http.setResponseCallback(http.expectedStatuses(200, 429));

// Note: k6 running on one machine looks like a single source IP to the
// server. At this scenario's ~900+ req/s, a run sustained past ~20-25s will
// also start tripping SELF_IP_LIMIT_PER_MINUTE (self_rate_limited 429s,
// no X-RateLimit-* headers) -- that's the self-protection layer doing its
// job against what looks like one very aggressive caller, not a defect.

export const options = {
  scenarios: {
    steady_load: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
    },
  },
  thresholds: {
    // The brief requires the check itself to stay in the low milliseconds;
    // this asserts the *end-to-end* HTTP latency (check + network + JSON)
    // stays well under 50ms at p95 under load.
    http_req_duration: ['p(95)<50'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function run() {
  const clientId = CLIENTS[Math.floor(Math.random() * CLIENTS.length)];
  const res = http.post(
    `${BASE_URL}/v1/check`,
    JSON.stringify({ clientId }),
    { headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY } },
  );

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has rate limit headers': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  });

  sleep(0.05);
}
