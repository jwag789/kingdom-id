import { type JWTPayload, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Browser,
  ISSUER,
  PASSWORD,
  type TestApp,
  authorizeUrl,
  createTestApp,
  location,
  pkce,
  redeem,
  registerClient,
  signUpAndAuthorize,
} from "../helpers.js";
import { sessions, users } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { leftHalfHash } from "../../src/oauth/tokens.js";

describe("authorization code flow, end to end", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const userIdFor = async (email: string) =>
    (await t.ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]?.id;

  const jwks = async () => createLocalJWKSet((await t.app.inject("/.well-known/jwks.json")).json());

  it("signs up, consents, and exchanges the code for verifiable tokens", async () => {
    const { client, secret } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client);

    // The authorization response goes to the exact registered URI with state and iss.
    expect(flow.callback.origin + flow.callback.pathname).toBe(flow.redirectUri);
    expect(flow.callback.searchParams.get("state")).toBe(flow.state);
    expect(flow.callback.searchParams.get("iss")).toBe(ISSUER);

    const res = await redeem(
      t.app,
      { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier },
      { id: client.id, secret: secret! },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const tokens = res.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: "openid profile email" });

    // ID token: verifiable against the published JWKS, with the claims OIDC requires.
    const { payload: id, protectedHeader } = await jwtVerify(tokens.id_token, await jwks(), {
      issuer: ISSUER,
      audience: client.id,
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(id).toMatchObject({ nonce: flow.nonce, amr: ["pwd"] });
    // Personal claims travel through UserInfo, not the ID token (OIDC Core §5.4).
    expect(id.email).toBeUndefined();
    expect(id.name).toBeUndefined();
    expect(id.auth_time).toBeTypeOf("number");
    expect(id.at_hash).toBe(leftHalfHash(tokens.access_token));
    expect(id.sid).toBeTypeOf("string");

    // Access token: an RFC 9068 JWT.
    expect(decodeProtectedHeader(tokens.access_token).typ).toBe("at+jwt");
    const { payload: at } = await jwtVerify<JWTPayload & { client_id: string }>(tokens.access_token, await jwks(), {
      issuer: ISSUER,
      audience: ISSUER,
      typ: "at+jwt",
    });
    expect(at.client_id).toBe(client.id);
    expect(at.sub).toBe(id.sub);

    // UserInfo returns the same subject and the consented claims.
    const info = await t.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({
      sub: id.sub,
      name: "Ada Lovelace",
      email: flow.email,
      email_verified: false,
      updated_at: expect.any(Number),
    });
  });

  it("signs ID tokens with ES256 for clients that registered it", async () => {
    const { client, secret } = await registerClient(t.ctx, { idTokenSignedResponseAlg: "ES256" });
    const flow = await signUpAndAuthorize(t.app, client);
    const res = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: client.id, secret: secret! });
    const { protectedHeader } = await jwtVerify(res.json().id_token, await jwks(), { issuer: ISSUER, audience: client.id });
    expect(protectedHeader.alg).toBe("ES256");
  });

  it("releases only consented scopes", async () => {
    const { client, secret } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client, { extra: { scope: "openid" } });
    const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: client.id, secret: secret! })).json();
    expect(tokens.scope).toBe("openid");
    const info = await t.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(Object.keys(info.json())).toEqual(["sub"]);
  });

  it("gives each app a different, stable pairwise subject", async () => {
    const a = await registerClient(t.ctx);
    const b = await registerClient(t.ctx);
    const first = await signUpAndAuthorize(t.app, a.client);
    const subA = (await redeem(t.app, { code: first.code, redirect_uri: first.redirectUri, code_verifier: first.verifier }, { id: a.client.id, secret: a.secret! })).json();

    // Same browser (already signed in) authorizes app B.
    const { verifier, challenge } = pkce();
    const start = await first.browser.get(
      authorizeUrl({ client_id: b.client.id, redirect_uri: b.client.redirectUris[0]!, code_challenge: challenge, code_challenge_method: "S256" }),
    );
    const interaction = location(start).pathname;
    const consent = await first.browser.submit(interaction, `${interaction}/consent`, { decision: "allow" });
    const code = location(consent).searchParams.get("code")!;
    const subB = (await redeem(t.app, { code, redirect_uri: b.client.redirectUris[0]!, code_verifier: verifier }, { id: b.client.id, secret: b.secret! })).json();

    const sub = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).sub;
    expect(sub(subA.id_token)).not.toBe(sub(subB.id_token));
    expect(sub(subA.id_token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("skips the consent screen once consent is on file, and honours prompt=none", async () => {
    const { client } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client);
    const { challenge } = pkce();
    const params = { client_id: client.id, redirect_uri: flow.redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "again" };

    const silent = await flow.browser.get(authorizeUrl(params));
    expect(location(silent).searchParams.get("code")).toBeTruthy();

    const none = await flow.browser.get(authorizeUrl({ ...params, prompt: "none" }));
    expect(location(none).searchParams.get("code")).toBeTruthy();
    expect(location(none).searchParams.get("state")).toBe("again");

    // A browser with no session gets login_required, not a login page.
    const stranger = await new Browser(t.app).get(authorizeUrl({ ...params, prompt: "none" }));
    expect(location(stranger).searchParams.get("error")).toBe("login_required");

    // Wider scope than consented: consent_required.
    const narrow = await registerClient(t.ctx);
    const narrowFlow = await signUpAndAuthorize(t.app, narrow.client, { extra: { scope: "openid" } });
    const wider = await narrowFlow.browser.get(
      authorizeUrl({ ...params, client_id: narrow.client.id, redirect_uri: narrow.client.redirectUris[0]!, prompt: "none" }),
    );
    expect(location(wider).searchParams.get("error")).toBe("consent_required");
  });

  it("forces a fresh sign-in for prompt=login and an exceeded max_age", async () => {
    const { client } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client);
    const { challenge } = pkce();
    const params = { client_id: client.id, redirect_uri: flow.redirectUri, code_challenge: challenge, code_challenge_method: "S256" };

    // Within max_age, the existing session is enough: straight back to the client.
    const fresh = await flow.browser.get(authorizeUrl({ ...params, max_age: "300" }));
    expect(location(fresh).searchParams.get("code")).toBeTruthy();

    for (const extra of [{ prompt: "login" }, { max_age: "60" }] as Record<string, string>[]) {
      // Age every session for this user past max_age, without waiting on the clock.
      await t.ctx.db
        .update(sessions)
        .set({ authTime: new Date(Date.now() - 120_000) })
        .where(eq(sessions.userId, (await userIdFor(flow.email))!));
      const res = await flow.browser.get(authorizeUrl({ ...params, ...extra }));
      const interaction = location(res).pathname;
      const page = await flow.browser.get(interaction);
      expect(page.body).toContain("Sign in");
      const login = await flow.browser.submit(interaction, `${interaction}/login`, { email: flow.email, password: PASSWORD });
      expect(login.statusCode).toBe(303);
      const done = await flow.browser.get(location(login).pathname);
      expect(location(done).searchParams.get("code")).toBeTruthy();
    }
  });

  it("returns access_denied when the user cancels", async () => {
    const { client } = await registerClient(t.ctx);
    const browser = new Browser(t.app);
    const { challenge } = pkce();
    const start = await browser.get(
      authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, code_challenge: challenge, code_challenge_method: "S256", state: "st" }),
    );
    const interaction = location(start).pathname;
    await browser.submit(`${interaction}/signup`, `${interaction}/signup`, { name: "Grace", email: `g-${Date.now()}@example.test`, password: PASSWORD });
    const deny = await browser.submit(interaction, `${interaction}/consent`, { decision: "deny" });
    const url = location(deny);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("signs in an existing user and shows the account page", async () => {
    const { client } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client);
    const browser = new Browser(t.app);
    const res = await browser.submit("/login", "/login", { email: flow.email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(303);
    const account = await browser.get("/account");
    expect(account.body).toContain(flow.email);

    const wrong = await new Browser(t.app).submit("/login", "/login", { email: flow.email, password: "wrong password!" });
    expect(wrong.statusCode).toBe(401);
    const unknown = await new Browser(t.app).submit("/login", "/login", { email: "nobody@example.test", password: "wrong password!" });
    // Same message whether or not the account exists.
    expect(unknown.body).toContain("match a Kingdom account");
    expect(wrong.body).toContain("match a Kingdom account");
  });

  it("verifies email addresses through a single-use link", async () => {
    const sent: { to: string; text: string }[] = [];
    const local = await createTestApp();
    // Swap in a capturing mailer.
    (local.ctx.emailVerification as unknown as { mailer: { send: (m: { to: string; text: string }) => Promise<void> } }).mailer = {
      send: async (m) => void sent.push(m),
    };
    const browser = new Browser(local.app);
    const email = `v-${Date.now()}@example.test`;
    await browser.submit("/signup", "/signup", { name: "Vera", email, password: PASSWORD });
    const link = new URL(sent.find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0]);
    expect((await browser.get(link.pathname + link.search)).statusCode).toBe(200);
    const account = (await browser.get("/account")).body;
    expect(account).toContain("verified");
    expect(account).not.toContain("not verified");
    expect((await browser.get(link.pathname + link.search)).statusCode).toBe(400);
    await local.close();
  });
});
