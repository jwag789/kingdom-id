/**
 * Kingdom Demo: a relying party that proves the provider works with a client
 * it didn't write. All protocol work is done by `openid-client`, an
 * independent certified library, so this app only wires up routes.
 */
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";

const issuer = process.env.ISSUER ?? "http://localhost:4000";
const clientId = process.env.DEMO_CLIENT_ID ?? "kingdom-demo";
const clientSecret = process.env.DEMO_CLIENT_SECRET;
const port = Number(process.env.DEMO_PORT ?? 4001);
const baseUrl = process.env.DEMO_URL ?? `http://localhost:${port}`;
const redirectUri = `${baseUrl}/callback`;
if (!clientSecret) throw new Error("DEMO_CLIENT_SECRET is required (run `pnpm seed` to create the demo client)");

const insecure = new URL(issuer).protocol === "http:";
const config = await oidc.discovery(
  new URL(issuer),
  clientId,
  { client_secret: clientSecret },
  oidc.ClientSecretBasic(clientSecret),
  insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
);

// Demo-grade session store. A real app would use its framework's sessions.
const sessions = new Map<string, { idTokenClaims: Record<string, unknown>; userinfo: Record<string, unknown> }>();
const pending = new Map<string, { verifier: string; state: string; nonce: string }>();

const app = Fastify({ logger: true });
await app.register(cookie, { secret: randomBytes(32).toString("hex") });
const cookieOpts = { httpOnly: true, sameSite: "lax" as const, path: "/", signed: true, secure: !insecure };

app.get("/", async (req, reply) => {
  const sid = req.unsignCookie(req.cookies.demo_sid ?? "");
  const session = sid.valid && sid.value ? sessions.get(sid.value) : undefined;
  reply.type("text/html; charset=utf-8");
  if (!session) {
    return page(`
      <h1>Kingdom Demo</h1>
      <p>A sample app that signs in with Kingdom ID.</p>
      <a class="button" href="/login">Sign in with Kingdom</a>`);
  }
  return page(`
    <h1 data-testid="greeting">Signed in as ${esc(String(session.userinfo.name ?? session.userinfo.sub))}</h1>
    <h2>ID token claims</h2><pre data-testid="id-token">${esc(JSON.stringify(session.idTokenClaims, null, 2))}</pre>
    <h2>UserInfo response</h2><pre data-testid="userinfo">${esc(JSON.stringify(session.userinfo, null, 2))}</pre>
    <a class="button" href="/logout">Sign out of the demo</a>`);
});

app.get("/login", async (_req, reply) => {
  const verifier = oidc.randomPKCECodeVerifier();
  const txn = { verifier, state: oidc.randomState(), nonce: oidc.randomNonce() };
  const id = randomBytes(16).toString("base64url");
  pending.set(id, txn);
  reply.setCookie("demo_txn", id, { ...cookieOpts, maxAge: 600 });
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid profile email",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state: txn.state,
    nonce: txn.nonce,
  });
  return reply.redirect(url.href, 303);
});

app.get("/callback", async (req, reply) => {
  const txnId = req.unsignCookie(req.cookies.demo_txn ?? "");
  const txn = txnId.valid && txnId.value ? pending.get(txnId.value) : undefined;
  if (!txn) return reply.status(400).type("text/html").send(page("<h1>Sign-in expired</h1><a href='/'>Start again</a>"));
  pending.delete(txnId.value!);
  reply.clearCookie("demo_txn", { path: "/" });

  try {
    const tokens = await oidc.authorizationCodeGrant(config, new URL(req.url, baseUrl), {
      pkceCodeVerifier: txn.verifier,
      expectedState: txn.state,
      expectedNonce: txn.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims()!;
    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    const sid = randomBytes(16).toString("base64url");
    sessions.set(sid, { idTokenClaims: { ...claims }, userinfo: { ...userinfo } });
    reply.setCookie("demo_sid", sid, cookieOpts);
    return reply.redirect("/", 303);
  } catch (err) {
    req.log.warn({ err }, "sign-in failed");
    const message = err instanceof Error ? err.message : "unknown error";
    return reply.status(400).type("text/html").send(page(`<h1>Sign-in failed</h1><p data-testid="error">${esc(message)}</p><a href="/">Start again</a>`));
  }
});

app.get("/logout", async (req, reply) => {
  const sid = req.unsignCookie(req.cookies.demo_sid ?? "");
  if (sid.valid && sid.value) sessions.delete(sid.value);
  reply.clearCookie("demo_sid", { path: "/" });
  return reply.redirect("/", 303);
});

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kingdom Demo</title><style>
body{font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;background:#f6f8fc;color:#0a0f24}
.button{display:inline-block;background:#0054ee;color:#fff;padding:.75rem 1.25rem;border-radius:999px;text-decoration:none;font-weight:600}
pre{background:#fff;border:1px solid #dde2ec;border-radius:12px;padding:1rem;overflow:auto}
</style></head><body>${body}</body></html>`;
}

await app.listen({ port, host: "0.0.0.0" });
