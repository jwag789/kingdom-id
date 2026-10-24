import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Browser,
  PASSWORD,
  type TestApp,
  authorizeUrl,
  createTestApp,
  csrfFrom,
  location,
  pkce,
  registerClient,
  signUpAndAuthorize,
  uniqueEmail,
} from "../helpers.js";

describe("browser-facing security", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("never redirects to an unregistered URI (no open redirect)", async () => {
    const { client } = await registerClient(t.ctx);
    const res = await new Browser(t.app).get(
      authorizeUrl({ client_id: client.id, redirect_uri: "https://evil.example.com/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain("Unrecognized return address");
  });

  it("reports missing PKCE to the client's redirect URI", async () => {
    const { client } = await registerClient(t.ctx);
    const res = await new Browser(t.app).get(authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, state: "z" }));
    const url = location(res);
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("state")).toBe("z");
  });

  it("rejects form posts without a valid CSRF token", async () => {
    const browser = new Browser(t.app);
    await browser.get("/login");
    const missing = await browser.post("/login", { email: "a@example.test", password: PASSWORD });
    expect(missing.statusCode).toBe(403);
    const forged = await browser.post("/login", { email: "a@example.test", password: PASSWORD, csrf: "forged" });
    expect(forged.statusCode).toBe(403);
  });

  it("rejects cross-site form posts even with a token", async () => {
    const browser = new Browser(t.app);
    const page = await browser.get("/login");
    const res = await browser.post(
      "/login",
      { email: "a@example.test", password: PASSWORD, csrf: csrfFrom(page.body) },
      { "sec-fetch-site": "cross-site" },
    );
    expect(res.statusCode).toBe(403);
  });

  it("binds an interaction to the browser that started it", async () => {
    const { client } = await registerClient(t.ctx);
    const victim = new Browser(t.app);
    const start = await victim.get(
      authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, code_challenge: pkce().challenge, code_challenge_method: "S256" }),
    );
    const interaction = location(start).pathname;
    const attacker = new Browser(t.app);
    const res = await attacker.get(interaction);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("expired");
  });

  it("completes an interaction only once", async () => {
    const { client } = await registerClient(t.ctx);
    const browser = new Browser(t.app);
    const start = await browser.get(
      authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, code_challenge: pkce().challenge, code_challenge_method: "S256" }),
    );
    const interaction = location(start).pathname;
    await browser.submit(`${interaction}/signup`, `${interaction}/signup`, { name: "Once", email: uniqueEmail(), password: PASSWORD });
    const page = await browser.get(interaction);
    const csrf = csrfFrom(page.body);
    const [a, b] = await Promise.all([
      browser.post(`${interaction}/consent`, { csrf, decision: "allow" }),
      browser.post(`${interaction}/consent`, { csrf, decision: "allow" }),
    ]);
    const codes = [a, b].filter((r) => r.headers.location?.toString().includes("code="));
    expect(codes).toHaveLength(1);
  });

  it("sets hardened cookies", async () => {
    const { client } = await registerClient(t.ctx);
    const browser = new Browser(t.app);
    const start = await browser.get(
      authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, code_challenge: pkce().challenge, code_challenge_method: "S256" }),
    );
    const interaction = location(start).pathname;
    const page = await browser.get(`${interaction}/signup`);
    const res = await browser.post(`${interaction}/signup`, { csrf: csrfFrom(page.body), name: "C", email: uniqueEmail(), password: PASSWORD });
    const session = (res.cookies as { name: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; path?: string; domain?: string }[]).find(
      (c) => c.name === "__Host-kid_session",
    );
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(session?.domain).toBeUndefined();
  });

  it("sends security headers, including a form-action that allows the client on consent", async () => {
    const { client } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client);
    const res = await flow.browser.get("/login");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");

    const start = await flow.browser.get(
      authorizeUrl({ client_id: client.id, redirect_uri: flow.redirectUri, code_challenge: pkce().challenge, code_challenge_method: "S256", prompt: "consent" }),
    );
    const consent = await flow.browser.get(location(start).pathname);
    expect(consent.headers["content-security-policy"]).toContain(`form-action 'self' ${new URL(flow.redirectUri).origin}`);
  });

  it("rate limits login attempts per account and reports Retry-After", async () => {
    const email = uniqueEmail();
    let last;
    for (let i = 0; i < 11; i++) {
      // Fresh IP each time: the per-account limit is the one being exercised.
      last = await new Browser(t.app).submit("/login", "/login", { email, password: "wrong password!" });
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rate limits the authorization endpoint per IP", async () => {
    const browser = new Browser(t.app);
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await browser.get("/authorize?client_id=nope")).statusCode);
    expect(statuses.slice(0, 60).every((s) => s === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rejects weak signup input with field errors", async () => {
    const browser = new Browser(t.app);
    const res = await browser.submit("/signup", "/signup", { name: "", email: "not-an-email", password: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Enter your name");
    expect(res.body).toContain("Enter a valid email address");
    expect(res.body).toContain("at least 10 characters");
  });

  it("escapes user-controlled text in pages", async () => {
    const browser = new Browser(t.app);
    const res = await browser.submit("/signup", "/signup", { name: "<script>alert(1)</script>", email: "x", password: "short" });
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script>");
  });
});
