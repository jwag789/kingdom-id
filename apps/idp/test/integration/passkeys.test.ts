import { passkeys, users } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACR_PASSWORD } from "../../src/accounts/auth-methods.js";
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
  uniqueEmail,
} from "../helpers.js";
import { SoftAuthenticator } from "../support/authenticator.js";

describe("passkeys", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  /** Signs a new user up with a passkey, optionally inside an app's authorization. */
  async function passkeySignup(opts: { browser?: Browser; interaction?: string; synced?: boolean } = {}) {
    const browser = opts.browser ?? new Browser(t.app);
    const authenticator = new SoftAuthenticator(ISSUER, { synced: opts.synced ?? true });
    const csrf = await browser.csrf("/signup");
    const email = uniqueEmail();
    const options = await browser.json("/passkeys/register/options", { csrf, mode: "signup", name: "Ada Lovelace", email, interaction: opts.interaction });
    expect(options.statusCode).toBe(200);
    const res = await browser.json("/passkeys/register", { csrf, interaction: opts.interaction, response: authenticator.create(options.json()) });
    return { browser, authenticator, email, res, csrf };
  }

  async function passkeyLogin(browser: Browser, authenticator: SoftAuthenticator, interaction?: string) {
    const csrf = await browser.csrf("/login");
    const options = await browser.json("/passkeys/authenticate/options", { csrf });
    return browser.json("/passkeys/authenticate", { csrf, interaction, response: authenticator.get(options.json()) });
  }

  it("creates a passkey-only account and signs it in", async () => {
    const { browser, email, res } = await passkeySignup();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redirect: "/account" });
    const [user] = await t.ctx.db.select().from(users).where(eq(users.email, email));
    expect(user!.passwordHash).toBeNull();
    expect(user!.webauthnUserId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await browser.get("/account/keys")).body).toContain("No password. You sign in with passkeys only.");
  });

  it("signs in with a discoverable passkey: no username typed", async () => {
    const { authenticator } = await passkeySignup();
    const fresh = new Browser(t.app);
    const res = await passkeyLogin(fresh, authenticator);
    expect(res.statusCode).toBe(200);
    expect((await fresh.get("/account")).statusCode).toBe(200);
  });

  it("issues acr=phr and passkey amr through an app's authorization", async () => {
    const { client, secret } = await registerClient(t.ctx);
    const browser = new Browser(t.app);
    const { verifier, challenge } = pkce();
    const start = await browser.get(
      authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, code_challenge: challenge, code_challenge_method: "S256", nonce: "n" }),
    );
    const interaction = location(start).pathname.split("/").pop()!;
    const { res } = await passkeySignup({ browser, interaction, synced: true });
    expect(res.json()).toEqual({ redirect: `/interaction/${interaction}` });

    const consent = await browser.submit(`/interaction/${interaction}`, `/interaction/${interaction}/consent`, { decision: "allow" });
    const code = location(consent).searchParams.get("code")!;
    const tokens = (await redeem(t.app, { code, redirect_uri: client.redirectUris[0]!, code_verifier: verifier }, { id: client.id, secret: secret! })).json();
    const id = decodeJwt(tokens.id_token);
    expect(id.acr).toBe("phr");
    expect(id.amr).toEqual(["swk", "user", "mfa"]);
  });

  it("reports a hardware-bound (not synced) passkey as hwk", async () => {
    const { authenticator } = await passkeySignup({ synced: false });
    const { client, secret } = await registerClient(t.ctx);
    const browser = new Browser(t.app);
    const { verifier, challenge } = pkce();
    const start = await browser.get(
      authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, code_challenge: challenge, code_challenge_method: "S256" }),
    );
    const interaction = location(start).pathname.split("/").pop()!;
    await passkeyLogin(browser, authenticator, interaction);
    const consent = await browser.submit(`/interaction/${interaction}`, `/interaction/${interaction}/consent`, { decision: "allow" });
    const code = location(consent).searchParams.get("code")!;
    const tokens = (await redeem(t.app, { code, redirect_uri: client.redirectUris[0]!, code_verifier: verifier }, { id: client.id, secret: secret! })).json();
    expect(decodeJwt(tokens.id_token).amr).toEqual(["hwk", "user", "mfa"]);
  });

  it("gives password sign-ins the password acr", async () => {
    const { client, secret } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client);
    const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: client.id, secret: secret! })).json();
    expect(decodeJwt(tokens.id_token).acr).toBe(ACR_PASSWORD);
  });

  it("steps a password session up when the app asks for acr_values=phr", async () => {
    const { client } = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, client);
    const params = { client_id: client.id, redirect_uri: flow.redirectUri, code_challenge: pkce().challenge, code_challenge_method: "S256" };

    // Asking for the level the session already has changes nothing.
    const same = await flow.browser.get(authorizeUrl({ ...params, acr_values: ACR_PASSWORD }));
    expect(location(same).searchParams.get("code")).toBeTruthy();

    const stepUp = await flow.browser.get(authorizeUrl({ ...params, acr_values: "phr" }));
    const page = await flow.browser.get(location(stepUp).pathname);
    expect(page.body).toContain("asks you to confirm it");
    expect(page.body).toContain("Sign in to");

    // Unknown acr values are ignored rather than forcing a sign-in.
    const unknown = await flow.browser.get(authorizeUrl({ ...params, acr_values: "urn:example:unknown" }));
    expect(location(unknown).searchParams.get("code")).toBeTruthy();
  });

  it("publishes acr_values_supported", async () => {
    const doc = (await t.app.inject("/.well-known/openid-configuration")).json();
    expect(doc.acr_values_supported).toEqual(["phr", ACR_PASSWORD]);
  });

  describe("ceremony integrity", () => {
    it("uses each challenge once", async () => {
      const { authenticator } = await passkeySignup();
      const browser = new Browser(t.app);
      const csrf = await browser.csrf();
      const options = (await browser.json("/passkeys/authenticate/options", { csrf })).json();
      const assertion = authenticator.get(options);
      expect((await browser.json("/passkeys/authenticate", { csrf, response: assertion })).statusCode).toBe(200);
      const replay = await browser.json("/passkeys/authenticate", { csrf, response: assertion });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toMatch(/expired/);
    });

    it("binds the challenge to the browser that requested it", async () => {
      const { authenticator } = await passkeySignup();
      const victim = new Browser(t.app);
      const options = (await victim.json("/passkeys/authenticate/options", { csrf: await victim.csrf() })).json();
      const attacker = new Browser(t.app);
      const res = await attacker.json("/passkeys/authenticate", { csrf: await attacker.csrf(), response: authenticator.get(options) });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an assertion made for another origin (phishing)", async () => {
      const { authenticator } = await passkeySignup();
      const browser = new Browser(t.app);
      const csrf = await browser.csrf();
      const options = (await browser.json("/passkeys/authenticate/options", { csrf })).json();
      const res = await browser.json("/passkeys/authenticate", {
        csrf,
        response: authenticator.get(options, { origin: "https://kingdom-id.evil.example" }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a user handle that doesn't match the credential's owner", async () => {
      const { authenticator } = await passkeySignup();
      const browser = new Browser(t.app);
      const csrf = await browser.csrf();
      const options = (await browser.json("/passkeys/authenticate/options", { csrf })).json();
      const res = await browser.json("/passkeys/authenticate", {
        csrf,
        response: authenticator.get(options, { userHandle: Buffer.alloc(32, 1).toString("base64url") }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a signature counter that went backwards (cloned authenticator)", async () => {
      const { authenticator } = await passkeySignup({ synced: false });
      await passkeyLogin(new Browser(t.app), authenticator);
      authenticator.rewindCounter();
      const res = await passkeyLogin(new Browser(t.app), authenticator);
      expect(res.statusCode).toBe(400);
    });

    it("requires user verification", async () => {
      const browser = new Browser(t.app);
      const authenticator = new SoftAuthenticator(ISSUER, { userVerification: false });
      const csrf = await browser.csrf("/signup");
      const options = (await browser.json("/passkeys/register/options", { csrf, mode: "signup", name: "U", email: uniqueEmail() })).json();
      const res = await browser.json("/passkeys/register", { csrf, response: authenticator.create(options) });
      expect(res.statusCode).toBe(400);
    });

    it("rejects unknown credentials and requests without CSRF", async () => {
      const browser = new Browser(t.app);
      const csrf = await browser.csrf();
      const options = (await browser.json("/passkeys/authenticate/options", { csrf })).json();
      const stranger = new SoftAuthenticator(ISSUER);
      expect((await browser.json("/passkeys/authenticate", { csrf, response: stranger.get(options) })).statusCode).toBe(400);
      const noCsrf = await browser.json("/passkeys/authenticate/options", {});
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.json().error).toMatch(/expired/);
    });
  });

  describe("signup validation", () => {
    it("validates fields before any ceremony starts", async () => {
      const browser = new Browser(t.app);
      const res = await browser.json("/passkeys/register/options", { csrf: await browser.csrf("/signup"), mode: "signup", name: "", email: "nope" });
      expect(res.statusCode).toBe(400);
      expect(res.json().fields).toMatchObject({ name: "Enter your name", email: "Enter a valid email address" });
    });

    it("refuses an email that already has an account", async () => {
      const { email } = await passkeySignup();
      const browser = new Browser(t.app);
      const res = await browser.json("/passkeys/register/options", { csrf: await browser.csrf("/signup"), mode: "signup", name: "X", email });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("managing passkeys", () => {
    it("adds a passkey to a password account and keeps the session", async () => {
      const browser = new Browser(t.app);
      const email = uniqueEmail();
      await browser.submit("/signup", "/signup", { name: "Pat", email, password: PASSWORD });
      const authenticator = new SoftAuthenticator(ISSUER);
      const csrf = await browser.csrf("/account");
      const options = (await browser.json("/passkeys/register/options", { csrf, mode: "add" })).json();
      const res = await browser.json("/passkeys/register", { csrf, response: authenticator.create(options) });
      expect(res.json()).toEqual({ redirect: "/account/keys?added=passkey" });
      expect((await browser.get("/account/keys?added=passkey")).body).toContain("Passkey added");

      // The same authenticator is excluded from a second registration.
      const again = (await browser.json("/passkeys/register/options", { csrf, mode: "add" })).json();
      expect(again.excludeCredentials.map((c: { id: string }) => c.id)).toContain(authenticator.id);

      // And the new passkey signs this account in.
      expect((await passkeyLogin(new Browser(t.app), authenticator)).statusCode).toBe(200);
    });

    it("requires a session to add a passkey", async () => {
      const browser = new Browser(t.app);
      const res = await browser.json("/passkeys/register/options", { csrf: await browser.csrf(), mode: "add" });
      expect(res.statusCode).toBe(401);
    });

    it("won't remove the last way to sign in", async () => {
      const { browser, email } = await passkeySignup();
      const [user] = await t.ctx.db.select().from(users).where(eq(users.email, email));
      const [only] = await t.ctx.db.select().from(passkeys).where(eq(passkeys.userId, user!.id));
      const res = await browser.submit("/account", `/account/passkeys/${only!.id}/delete`, {});
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("only way to sign in");

      // With a second passkey, the first can go.
      const second = new SoftAuthenticator(ISSUER);
      const csrf = await browser.csrf("/account");
      const options = (await browser.json("/passkeys/register/options", { csrf, mode: "add" })).json();
      await browser.json("/passkeys/register", { csrf, response: second.create(options) });
      const removed = await browser.submit("/account", `/account/passkeys/${only!.id}/delete`, {});
      expect(removed.statusCode).toBe(303);
      expect(await t.ctx.db.select().from(passkeys).where(eq(passkeys.userId, user!.id))).toHaveLength(1);
    });

    it("can't remove someone else's passkey", async () => {
      const victim = await passkeySignup();
      const [victimUser] = await t.ctx.db.select().from(users).where(eq(users.email, victim.email));
      const [victimKey] = await t.ctx.db.select().from(passkeys).where(eq(passkeys.userId, victimUser!.id));
      const attacker = new Browser(t.app);
      await attacker.submit("/signup", "/signup", { name: "Mallory", email: uniqueEmail(), password: PASSWORD });
      const res = await attacker.submit("/account", `/account/passkeys/${victimKey!.id}/delete`, {});
      expect(res.statusCode).toBe(400);
      expect(await t.ctx.db.select().from(passkeys).where(eq(passkeys.id, victimKey!.id))).toHaveLength(1);
    });
  });
});
