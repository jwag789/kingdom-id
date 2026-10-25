// k6 load test of the token endpoint: refresh-token rotation.
//
// Each request authenticates the client (client_secret_basic), redeems a
// refresh token (database read, conditional update, insert), signs an
// RS256 access token and ID token, records last-used, and passes two Redis
// rate limits. Every VU rotates its own chain, so each refresh token is used
// exactly once, as a real client would.
import http from "k6/http";
import encoding from "k6/encoding";
import { check, fail } from "k6";

const data = JSON.parse(open("/results/load-tokens.json"));
const target = __ENV.TARGET;
const label = __ENV.LABEL || "run";
const vus = Number(__ENV.VUS || 50);

export const options = {
  insecureSkipTLSVerify: true, // Caddy's internal CA, local only
  discardResponseBodies: false,
  scenarios: {
    refresh: { executor: "constant-vus", vus, duration: __ENV.DURATION || "60s" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:token_refresh}": ["p(95)<500"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

if (data.tokens.length < vus) fail(`need ${vus} refresh tokens, have ${data.tokens.length}`);

const authorization = "Basic " + encoding.b64encode(`${encodeURIComponent(data.clientId)}:${encodeURIComponent(data.clientSecret)}`);
let current;

export default function () {
  current = current || data.tokens[__VU - 1];
  const res = http.post(
    `${target}/token`,
    { grant_type: "refresh_token", refresh_token: current },
    { headers: { Authorization: authorization }, tags: { name: "token_refresh" } },
  );
  const ok = check(res, { "status is 200": (r) => r.status === 200 });
  if (!ok) fail(`refresh failed with ${res.status}: ${res.body}`);
  current = res.json("refresh_token");
}

export function handleSummary(summary) {
  const d = summary.metrics["http_req_duration{name:token_refresh}"] || summary.metrics.http_req_duration;
  const reqs = summary.metrics.http_reqs.values;
  const failed = summary.metrics.http_req_failed.values.rate;
  const result = {
    label,
    target,
    vus,
    // k6 doesn't expose the module's options inside handleSummary; read the env instead.
    duration: __ENV.DURATION || "60s",
    requests: reqs.count,
    rps: Math.round(reqs.rate * 10) / 10,
    failedRate: failed,
    latencyMs: Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, Math.round(v * 10) / 10])),
  };
  const line = `${label}: ${result.requests} requests, ${result.rps} req/s, p50 ${result.latencyMs.med} ms, p95 ${result.latencyMs["p(95)"]} ms, p99 ${result.latencyMs["p(99)"]} ms, failed ${(failed * 100).toFixed(2)}%`;
  return { stdout: `\n${line}\n`, [`/results/k6-${label}.json`]: JSON.stringify(result, null, 2) };
}
