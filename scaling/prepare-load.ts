/**
 * Mints one refresh token per k6 virtual user. Each VU then rotates its own
 * chain, so no two VUs ever present the same token (which would, correctly,
 * trip reuse detection and revoke the family).
 */
import { writeFileSync } from "node:fs";
import * as oidc from "openid-client";
import { Browser, ISSUER, csrfFrom, kingdom } from "./lib.js";

const count = Number(process.argv[2] ?? 50);
const out = process.argv[3] ?? "results/load-tokens.json";

const created = JSON.parse(
  kingdom("idp-1", ["clients", "create", "--name", `Load Test ${Date.now()}`, "--redirect-uri", "https://load.example/callback", "--json"]),
) as { client_id: string; client_secret: string };
const config = await oidc.discovery(new URL(ISSUER), created.client_id, { client_secret: created.client_secret }, oidc.ClientSecretBasic(created.client_secret));

const browser = new Browser();
const tokens: string[] = [];
for (let i = 0; i < count; i++) {
  const verifier = oidc.randomPKCECodeVerifier();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: "https://load.example/callback",
    scope: "openid offline_access",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  let hop = await browser.go("authorize", url.href);
  if (hop.location?.startsWith("/interaction/")) {
    // First pass only: sign up and consent. Later passes ride the session and stored consent.
    const interaction = hop.location;
    const signup = await browser.go("signup page", `${interaction}/signup`);
    await browser.go("signup", `${interaction}/signup`, {
      csrf: csrfFrom(signup.body),
      name: "Load Tester",
      email: `load-${Date.now()}@example.test`,
      password: "correct horse battery staple",
    });
    const consent = await browser.go("consent page", interaction);
    hop = await browser.go("consent", `${interaction}/consent`, { csrf: csrfFrom(consent.body), decision: "allow" });
  }
  const result = await oidc.authorizationCodeGrant(config, new URL(hop.location!), { pkceCodeVerifier: verifier });
  tokens.push(result.refresh_token!);
}
writeFileSync(out, JSON.stringify({ clientId: created.client_id, clientSecret: created.client_secret, tokens }));
console.log(`minted ${tokens.length} refresh tokens → ${out}`);
