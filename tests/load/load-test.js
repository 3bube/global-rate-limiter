// k6 load/performance test for POST /v1/check.
//
// Run (with the stack up via docker compose):
//   docker run --rm -i --network=host grafana/k6 run - < tests/load/load-test.js
// or, if k6 is installed locally:
//   BASE_URL=http://localhost:3000 k6 run tests/load/load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const CLIENTS = ['client-a', 'client-b'];

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
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has rate limit headers': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  });

  sleep(0.05);
}
