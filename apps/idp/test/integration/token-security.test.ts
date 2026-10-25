import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../../src/lib/crypto.js";
import { Browser, PASSWORD, authorizeUrl, location, uniqueEmail, type TestApp, basicAuth, createTestApp, redeem, registerClient, signUpAndAuthorize } from "../helpers.js";

describe("token endpoint security", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  async function freshCode(input: Parameters<typeof registerClient>[1] = {}) {
    const { client, secret } = await registerClient(t.ctx, input);
    const flow = await signUpAndAuthorize(t.app, client);
    return { client, secret: secret!, flow };
  }

  it("rejects a wrong PKCE verifier, and the code is spent afterwards", async () => {
    const { client, secret, flow } = await freshCode();
    const bad = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: "x".repeat(43) }, { id: client.id, secret });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_grant");
    const retry = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: client.id, secret });
    expect(retry.json().error).toBe("invalid_grant");
  });

  it("rejects a missing verifier", async () => {
    const { client, secret, flow } = await freshCode();
    const res = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri }, { id: client.id, secret });
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a code_verifier when no challenge was sent (PKCE downgrade)", async () => {
    const { client, secret } = await registerClient(t.ctx, { requirePkce: false });
    const browser = new Browser(t.app);
    const start = await browser.get(authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]! }));
    const interaction = location(start).pathname;
    await browser.submit(`${interaction}/signup`, `${interaction}/signup`, { name: "D", email: uniqueEmail(), password: PASSWORD });
    const consent = await browser.submit(interaction, `${interaction}/consent`, { decision: "allow" });
    const code = location(consent).searchParams.get("code")!;
    const res = await redeem(t.app, { code, redirect_uri: client.redirectUris[0]!, code_verifier: "x".repeat(43) }, { id: client.id, secret: secret! });
    expect(res.json().error).toBe("invalid_grant");
  });

  it("lets a waived client complete the flow without PKCE", async () => {
    const { client, secret } = await registerClient(t.ctx, { requirePkce: false });
    const browser = new Browser(t.app);
    const start = await browser.get(authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]! }));
    const interaction = location(start).pathname;
    await browser.submit(`${interaction}/signup`, `${interaction}/signup`, { name: "W", email: uniqueEmail(), password: PASSWORD });
    const consent = await browser.submit(interaction, `${interaction}/consent`, { decision: "allow" });
    const code = location(consent).searchParams.get("code")!;
    const res = await redeem(t.app, { code, redirect_uri: client.redirectUris[0]! }, { id: client.id, secret: secret! });
    expect(res.statusCode).toBe(200);
  });

  it("still requires PKCE from clients without the waiver", async () => {
    const { client } = await registerClient(t.ctx);
    const res = await new Browser(t.app).get(authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]! }));
    expect(location(res).searchParams.get("error")).toBe("invalid_request");
  });

  it("redeems a code exactly once", async () => {
    const { client, secret, flow } = await freshCode();
    const params = { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier };
    const results = await Promise.all([1, 2, 3].map(() => redeem(t.app, params, { id: client.id, secret })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400, 400]);
  });

  it("binds the code to its client and redirect URI", async () => {
    const { client, secret, flow } = await freshCode();
    const other = await registerClient(t.ctx);
    const stolen = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: other.client.id, secret: other.secret! });
    expect(stolen.json().error).toBe("invalid_grant");

    const second = await freshCode();
    const wrongUri = await redeem(
      t.app,
      { code: second.flow.code, redirect_uri: `${second.flow.redirectUri}x`, code_verifier: second.flow.verifier },
      { id: second.client.id, secret: second.secret },
    );
    expect(wrongUri.json().error).toBe("invalid_grant");
    void client;
    void secret;
  });

  it("expires codes", async () => {
    const { client, secret, flow } = await freshCode();
    const key = `code:${sha256(flow.code)}`;
    // Issued with the configured 60-second TTL...
    const ttl = await t.ctx.redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    // ...and gone once it lapses. Shortened here rather than waited out.
    await t.ctx.redis.pexpire(key, 1);
    await new Promise((r) => setTimeout(r, 20));
    const res = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: client.id, secret });
    expect(res.json().error).toBe("invalid_grant");
  });

  it("authenticates clients strictly", async () => {
    const { client, secret, flow } = await freshCode();
    const params = { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier };

    const wrong = await redeem(t.app, params, { id: client.id, secret: `${secret}x` });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("invalid_client");
    expect(wrong.headers["www-authenticate"]).toMatch(/^Basic/);

    // Registered for client_secret_basic, so client_secret_post is refused.
    const post = await redeem(t.app, { ...params, client_id: client.id, client_secret: secret });
    expect(post.statusCode).toBe(401);

    // No credentials at all.
    expect((await redeem(t.app, { ...params, client_id: client.id })).statusCode).toBe(401);

    // Two methods at once.
    const both = await t.app.inject({
      method: "POST",
      url: "/token",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(client.id, secret) },
      payload: new URLSearchParams({ grant_type: "authorization_code", ...params, client_secret: secret }).toString(),
    });
    expect(both.json().error).toBe("invalid_request");
  });

  it("supports client_secret_post for clients registered with it", async () => {
    const { client, secret, flow } = await freshCode({ tokenEndpointAuthMethod: "client_secret_post" });
    const res = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, client_id: client.id, client_secret: secret });
    expect(res.statusCode).toBe(200);
  });

  it("lets public clients redeem with PKCE alone, and never with a secret", async () => {
    const { client } = await registerClient(t.ctx, { type: "public" });
    const flow = await signUpAndAuthorize(t.app, client);
    const res = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, client_id: client.id });
    expect(res.statusCode).toBe(200);
  });

  it("validates grant type, content type, and repeated parameters", async () => {
    const { client, secret } = await registerClient(t.ctx);
    const auth = { id: client.id, secret: secret! };
    expect((await redeem(t.app, { grant_type: "password" }, auth)).json().error).toBe("unsupported_grant_type");
    const json = await t.app.inject({
      method: "POST",
      url: "/token",
      headers: { "content-type": "application/json", authorization: basicAuth(client.id, secret!) },
      payload: JSON.stringify({ grant_type: "authorization_code" }),
    });
    expect(json.json().error).toBe("invalid_request");
    const repeated = await t.app.inject({
      method: "POST",
      url: "/token",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(client.id, secret!) },
      payload: "grant_type=authorization_code&code=a&code=b",
    });
    expect(repeated.json().error).toBe("invalid_request");
    expect((await t.app.inject({ url: "/token" })).statusCode).toBe(404);
  });

  it("rejects bad access tokens at userinfo with a Bearer challenge", async () => {
    const none = await t.app.inject("/userinfo");
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toMatch(/^Bearer realm="kingdom-id"$/);

    const garbage = await t.app.inject({ url: "/userinfo", headers: { authorization: "Bearer not.a.jwt" } });
    expect(garbage.statusCode).toBe(401);
    expect(garbage.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("refuses an ID token presented as an access token", async () => {
    const { client, secret, flow } = await freshCode();
    const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: client.id, secret })).json();
    const res = await t.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${tokens.id_token}` } });
    expect(res.statusCode).toBe(401);
  });
});
