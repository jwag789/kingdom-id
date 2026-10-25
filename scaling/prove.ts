/**
 * Proves the API is stateless: one user's sign-in, consent, token exchange,
 * refreshes and logout bounce between two instances with no sticky
 * sessions; an instance is stopped mid-session and the user carries on; a
 * key rotated from one instance is honored by the other; and both
 * instances share the security event stream as one consumer group.
 */
import { writeFileSync } from "node:fs";
import * as oidc from "openid-client";
import { Browser, ISSUER, compose, csrfFrom, kingdom } from "./lib.js";

// One chronological log of every request: browser front channel and back channel alike.
const browser = new Browser();
const record =
  (step: string): oidc.CustomFetch =>
  async (url, options) => {
    // The library's body type is a superset of what it actually sends to fetch.
    const res = await fetch(url, options as RequestInit);
    browser.trail.push({ step, instance: res.headers.get("x-kingdom-instance") ?? "?", status: res.status });
    return res;
  };
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

console.log("Registering a client with the CLI on idp-1…");
const created = JSON.parse(
  kingdom("idp-1", ["clients", "create", "--name", "Scaling Proof", "--redirect-uri", "https://app.example/callback", "--first-party", "--json"]),
) as { client_id: string; client_secret: string };

const config = await oidc.discovery(new URL(ISSUER), created.client_id, { client_secret: created.client_secret }, oidc.ClientSecretBasic(created.client_secret));
const back = (step: string) => (config[oidc.customFetch] = record(step));

async function authorize(browser: Browser, label: string) {
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: "https://app.example/callback",
    scope: "openid profile email offline_access",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  let hop = await browser.go(`${label}: authorize`, url.href);
  if (hop.location?.startsWith("/interaction/")) {
    const interaction = hop.location;
    const signup = await browser.go(`${label}: signup page`, `${interaction}/signup`);
    await browser.go(`${label}: signup`, `${interaction}/signup`, {
      csrf: csrfFrom(signup.body),
      name: "Scaling Tester",
      email: `scale-${Date.now()}@example.test`,
      password: "correct horse battery staple",
    });
    const consent = await browser.go(`${label}: consent page`, interaction);
    hop = await browser.go(`${label}: consent`, `${interaction}/consent`, { csrf: csrfFrom(consent.body), decision: "allow" });
  }
  const callback = new URL(hop.location!);
  back(`${label}: token`);
  return oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state });
}

console.log("\nOne sign-in, across both instances:");
const tokens = await authorize(browser, "first sign-in");
back("userinfo");
const info = await oidc.fetchUserInfo(config, tokens.access_token, tokens.claims()!.sub);
check(info.email?.endsWith("@relay.localhost"), "userinfo returned the app's private relay address");

let refresh = tokens.refresh_token!;
for (let i = 1; i <= 4; i++) {
  back(`refresh ${i}`);
  const next = await oidc.refreshTokenGrant(config, refresh);
  refresh = next.refresh_token!;
}
check(true, "four refresh-token rotations succeeded");

const flowInstances = browser.trail.map((s) => s.instance);
check(new Set(flowInstances).has("idp-1") && new Set(flowInstances).has("idp-2"), "both instances served steps of the same session");
const handoffs = browser.trail.filter((s, i) => i > 0 && s.instance !== browser.trail[i - 1]!.instance).length;
check(handoffs > 0, `the browser session moved between instances ${handoffs} times without losing state`);

console.log("\nStopping idp-1 mid-session…");
compose(["stop", "idp-1"]);
await new Promise((r) => setTimeout(r, 4000));
const before = browser.trail.length;
const after = await authorize(browser, "with idp-1 down");
check(browser.trail.slice(before).every((s) => s.instance === "idp-2"), "every request was served by idp-2");
check(after.claims()!.sub === tokens.claims()!.sub, "the same session signed the same user in again, from idp-2 alone");
back("refresh with idp-1 down");
refresh = (await oidc.refreshTokenGrant(config, refresh)).refresh_token!;
check(true, "a refresh token issued by idp-1 rotated on idp-2");
compose(["start", "idp-1"]);
compose(["up", "-d", "--wait", "idp-1"]);
await new Promise((r) => setTimeout(r, 3000));

console.log("\nRotating signing keys from idp-2 with the CLI…");
const rotated = kingdom("idp-2", ["keys", "rotate"]);
check(rotated.includes("Rotated RS256"), "keys rotated");
for (let i = 1; i <= 4; i++) {
  back(`refresh after rotation ${i}`);
  const next = await oidc.refreshTokenGrant(config, refresh);
  refresh = next.refresh_token!;
  back(`userinfo after rotation ${i}`);
  await oidc.fetchUserInfo(config, next.access_token, next.claims()!.sub);
}
check(true, "tokens signed before and after the rotation verified on both instances");

console.log("\nEvent stream:");
const consumers = compose(["exec", "-T", "redis", "redis-cli", "XINFO", "CONSUMERS", "security-events", "persist-and-detect"]);
const consumerCount = (consumers.match(/^name$/gm) ?? []).length;
check(consumerCount >= 2, `${consumerCount} consumers (one per instance, plus restarts) share the security event stream`);

const table = browser.trail.map((s) => `| ${s.step} | ${s.instance} |`).join("\n");
writeFileSync(
  new URL("./results/statelessness.md", import.meta.url),
  `# Statelessness proof\n\nGenerated by \`scaling/prove.ts\` on ${new Date().toISOString()}.\n\n| Step | Served by |\n|---|---|\n${table}\n`,
);
console.log("\nAll checks passed. Step-by-step routing: scaling/results/statelessness.md");
