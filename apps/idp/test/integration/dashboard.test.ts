import { consents, perks as perksTable, securityEvents, users } from "@kingdom-id/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Browser,
  ISSUER,
  PASSWORD,
  type TestApp,
  authorizeUrl,
  clientPost,
  createTestApp,
  location,
  pkce,
  redeem,
  registerClient,
  signUpAndAuthorize,
  uniqueEmail,
} from "../helpers.js";
import { SoftAuthenticator } from "../support/authenticator.js";

describe("Your Kingdom dashboard", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  type Registered = Awaited<ReturnType<typeof registerClient>>;

  /** Connects the browser's (already signed-in) user to another app and returns its tokens. */
  async function connect(browser: Browser, app: Registered, scope = "openid profile email offline_access") {
    const { verifier, challenge } = pkce();
    const start = await browser.get(
      authorizeUrl({ client_id: app.client.id, redirect_uri: app.client.redirectUris[0]!, scope, code_challenge: challenge, code_challenge_method: "S256" }),
    );
    let callback = location(start);
    if (callback.pathname.startsWith("/interaction/")) {
      callback = location(await browser.submit(callback.pathname, `${callback.pathname}/consent`, { decision: "allow" }));
    }
    const code = callback.searchParams.get("code")!;
    return (await redeem(t.app, { code, redirect_uri: app.client.redirectUris[0]!, code_verifier: verifier }, { id: app.client.id, secret: app.secret! })).json();
  }

  async function userId(email: string) {
    const [u] = await t.ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    return u!.id;
  }

  const userinfo = (token: string) => t.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${token}` } });

  it("requires a session for every section", async () => {
    for (const path of ["/account", "/account/treasury", "/account/masks", "/account/watchtower", "/account/keys"]) {
      const res = await new Browser(t.app).get(path);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    }
  });

  describe("Realms", () => {
    it("lists each connected app with what it received and when it was last used", async () => {
      const first = await registerClient(t.ctx, { name: "Cappuccino" });
      const second = await registerClient(t.ctx, { name: "InkSpirit" });
      const flow = await signUpAndAuthorize(t.app, first.client, { extra: { scope: "openid email" } });
      await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: first.client.id, secret: first.secret! });
      await connect(flow.browser, second, "openid profile");

      const page = (await flow.browser.get("/account")).body;
      expect(page).toContain("Cappuccino");
      expect(page).toContain("InkSpirit");
      expect(page).toContain(flow.email);
      expect(page).toContain("Last used");
      expect(page).toContain("2</strong> realms");

      const [row] = await t.ctx.db
        .select()
        .from(consents)
        .where(and(eq(consents.userId, await userId(flow.email)), eq(consents.clientId, first.client.id)));
      expect(row!.lastUsedAt).toBeInstanceOf(Date);
    });

    it("disconnects an app in one click: consent gone, refresh family and access tokens dead, others untouched", async () => {
      const victim = await registerClient(t.ctx, { name: "Victim App" });
      const other = await registerClient(t.ctx, { name: "Other App" });
      const flow = await signUpAndAuthorize(t.app, victim.client, { extra: { scope: "openid email offline_access" } });
      const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: victim.client.id, secret: victim.secret! })).json();
      const otherTokens = await connect(flow.browser, other);
      expect((await userinfo(tokens.access_token)).statusCode).toBe(200);

      const res = await flow.browser.submit("/account", `/account/realms/${victim.client.id}/disconnect`, {});
      expect(res.statusCode).toBe(303);
      expect((await flow.browser.get(res.headers.location as string)).body).toContain("Disconnected Victim App");

      expect((await userinfo(tokens.access_token)).statusCode).toBe(401);
      const refresh = await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, { id: victim.client.id, secret: victim.secret! });
      expect(refresh.json().error).toBe("invalid_grant");
      expect((await userinfo(otherTokens.access_token)).statusCode).toBe(200);

      // Signing in to it again asks for consent again.
      const again = await flow.browser.get(
        authorizeUrl({ client_id: victim.client.id, redirect_uri: victim.client.redirectUris[0]!, code_challenge: pkce().challenge, code_challenge_method: "S256" }),
      );
      expect((await flow.browser.get(location(again).pathname)).body).toContain("Continue to Victim App?");
    });

    it("needs CSRF to disconnect", async () => {
      const app = await registerClient(t.ctx);
      const flow = await signUpAndAuthorize(t.app, app.client);
      const res = await flow.browser.post(`/account/realms/${app.client.id}/disconnect`, {});
      expect(res.statusCode).toBe(403);
      expect((await flow.browser.get("/account")).body).toContain(app.client.name);
    });
  });

  describe("Treasury and the perks claim", () => {
    it("evaluates every rule, skips paused perks, and exposes perks to first-party apps only", async () => {
      const kingdomApp = await registerClient(t.ctx, { name: "Cappuccino", firstParty: true });
      const secondApp = await registerClient(t.ctx, { name: "InkSpirit", firstParty: true });
      const thirdParty = await registerClient(t.ctx, { name: "Elsewhere" });
      const tag = Math.random().toString(36).slice(2, 8);
      const make = (p: Parameters<typeof t.ctx.perks.create>[0]) => t.ctx.perks.create(p);
      await make({ clientId: kingdomApp.client.id, slug: `c${tag}.welcome`, name: `Welcome ${tag}`, description: "d", rule: "connected" });
      const loyal = await make({ clientId: kingdomApp.client.id, slug: `c${tag}.loyal`, name: `Loyal ${tag}`, description: "d", rule: "connected_days", threshold: 30 });
      await make({ clientId: secondApp.client.id, slug: `i${tag}.two`, name: `Two realms ${tag}`, description: "d", rule: "connected_apps", threshold: 2 });
      const founder = await make({ clientId: kingdomApp.client.id, slug: `c${tag}.founder`, name: `Founder ${tag}`, description: "d", rule: "manual" });
      const paused = await make({ clientId: kingdomApp.client.id, slug: `c${tag}.paused`, name: `Paused ${tag}`, description: "d", rule: "connected" });
      await t.ctx.perks.setActive(paused.id, false);

      const flow = await signUpAndAuthorize(t.app, kingdomApp.client, { extra: { scope: "openid perks" } });
      const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: kingdomApp.client.id, secret: kingdomApp.secret! })).json();
      const id = await userId(flow.email);
      const slugs = async () => (await t.ctx.perks.claimFor(id)).map((p) => p.id).filter((s) => s.includes(tag)).sort();

      expect(await slugs()).toEqual([`c${tag}.welcome`]);

      await connect(flow.browser, secondApp, "openid");
      expect(await slugs()).toEqual([`c${tag}.welcome`, `i${tag}.two`]);

      await t.ctx.db
        .update(consents)
        .set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
        .where(and(eq(consents.userId, id), eq(consents.clientId, kingdomApp.client.id)));
      await t.ctx.perks.grant(founder.id, flow.email);
      expect(await slugs()).toEqual([`c${tag}.founder`, `c${tag}.loyal`, `c${tag}.welcome`, `i${tag}.two`]);

      // The claim, as a first-party app sees it.
      const info = (await userinfo(tokens.access_token)).json();
      expect(info.perks).toContainEqual({ id: `c${tag}.loyal`, name: loyal.name, app: "Cappuccino" });

      // A third-party app can't even get the scope.
      const outsider = await connect(flow.browser, thirdParty, "openid perks");
      expect(outsider.scope).toBe("openid");
      expect((await userinfo(outsider.access_token)).json().perks).toBeUndefined();

      const page = (await flow.browser.get("/account/treasury")).body;
      expect(page).toContain(`Founder ${tag}`);
      expect(page).not.toContain(`Paused ${tag}`);
    });

    it("explains what's left for perks within reach", async () => {
      const app = await registerClient(t.ctx, { name: "Reachable", firstParty: true });
      const tag = Math.random().toString(36).slice(2, 8);
      await t.ctx.perks.create({ clientId: app.client.id, slug: `r${tag}.month`, name: `Month ${tag}`, description: "d", rule: "connected_days", threshold: 30 });
      const flow = await signUpAndAuthorize(t.app, app.client, { extra: { scope: "openid" } });
      const page = (await flow.browser.get("/account/treasury")).body;
      expect(page).toContain(`Month ${tag}`);
      expect(page).toContain("30 more days connected to Reachable");
    });
  });

  describe("Watchtower", () => {
    it("records sign-ins, failed attempts, connected and disconnected apps, and shows only your own", async () => {
      const app = await registerClient(t.ctx, { name: "Watched App" });
      const flow = await signUpAndAuthorize(t.app, app.client);
      await new Browser(t.app).submit("/login", "/login", { email: flow.email, password: "wrong password!!" });
      await new Browser(t.app).submit("/login", "/login", { email: flow.email, password: PASSWORD });
      await flow.browser.submit("/account", `/account/realms/${app.client.id}/disconnect`, {});

      const id = await userId(flow.email);
      const types = (await t.ctx.db.select({ type: securityEvents.type }).from(securityEvents).where(eq(securityEvents.userId, id))).map((e) => e.type);
      expect(types).toEqual(expect.arrayContaining(["account_created", "app_connected", "sign_in_failed", "sign_in", "app_disconnected"]));

      const page = (await flow.browser.get("/account/watchtower")).body;
      expect(page).toContain("Failed sign-in attempt");
      expect(page).toContain("Allowed Watched App");
      expect(page).toContain("Disconnected Watched App");

      // Another user's tower is their own.
      const stranger = new Browser(t.app);
      await stranger.submit("/signup", "/signup", { name: "Someone Else", email: uniqueEmail(), password: PASSWORD });
      expect((await stranger.get("/account/watchtower")).body).not.toContain("Watched App");
    });

    it("raises an alert when a copied refresh token is replayed", async () => {
      const app = await registerClient(t.ctx, { name: "Reuse App" });
      const flow = await signUpAndAuthorize(t.app, app.client, { extra: { scope: "openid offline_access" } });
      const auth = { id: app.client.id, secret: app.secret! };
      const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, auth)).json();
      await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, auth);
      await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, auth);
      const page = (await flow.browser.get("/account/watchtower")).body;
      expect(page).toContain("Blocked a copied token for Reuse App");
      expect(page).toContain("event event-alert");
    });
  });

  describe("Masks", () => {
    it("shows each app and what email it has, with relay controls not yet active", async () => {
      const withEmail = await registerClient(t.ctx, { name: "Mailer" });
      const withoutEmail = await registerClient(t.ctx, { name: "Quiet" });
      const flow = await signUpAndAuthorize(t.app, withEmail.client, { extra: { scope: "openid email" } });
      await connect(flow.browser, withoutEmail, "openid");
      const page = (await flow.browser.get("/account/masks")).body;
      expect(page).toContain("Private addresses are on the way");
      expect(page).toContain("Not issued yet");
      expect(page).toContain("have your email address.");
      expect(page).toMatch(/<button[^>]*disabled[^>]*>Turn off forwarding/);
    });
  });

  describe("Admin", () => {
    async function adminBrowser(withPasskey: boolean) {
      const browser = new Browser(t.app);
      const email = uniqueEmail();
      if (withPasskey) {
        const authenticator = new SoftAuthenticator(ISSUER);
        const csrf = await browser.csrf("/signup");
        const options = (await browser.json("/passkeys/register/options", { csrf, mode: "signup", name: "Admin", email })).json();
        await browser.json("/passkeys/register", { csrf, response: authenticator.create(options) });
      } else {
        await browser.submit("/signup", "/signup", { name: "Admin", email, password: PASSWORD });
      }
      await t.ctx.db.update(users).set({ isAdmin: true }).where(eq(users.email, email));
      return browser;
    }

    it("is closed to non-admins and to admins without a passkey session", async () => {
      const member = new Browser(t.app);
      await member.submit("/signup", "/signup", { name: "Member", email: uniqueEmail(), password: PASSWORD });
      expect((await member.get("/admin")).statusCode).toBe(403);
      expect((await new Browser(t.app).get("/admin")).headers.location).toBe("/login");

      const passwordAdmin = await adminBrowser(false);
      const res = await passwordAdmin.get("/admin");
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("Admin needs a passkey sign-in");
    });

    it("creates, validates, pauses, grants and deletes perks", async () => {
      const app = await registerClient(t.ctx, { name: "Admin Target", firstParty: true });
      const admin = await adminBrowser(true);
      expect((await admin.get("/admin")).statusCode).toBe(200);

      const slug = `admin${Math.random().toString(36).slice(2, 8)}.vip`;
      const bad = await admin.submit("/admin", "/admin/perks", { clientId: app.client.id, slug: "Not A Slug", name: "", description: "x", rule: "connected_days" });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).toContain("Lowercase letters");
      expect(bad.body).toContain("This rule needs a number");

      const created = await admin.submit("/admin", "/admin/perks", { clientId: app.client.id, slug, name: "VIP", description: "Front of the line", rule: "manual" });
      expect(created.statusCode).toBe(303);
      const duplicate = await admin.submit("/admin", "/admin/perks", { clientId: app.client.id, slug, name: "VIP", description: "x", rule: "manual" });
      expect(duplicate.body).toContain("already exists");

      const [perk] = await t.ctx.db.select().from(perksTable).where(eq(perksTable.slug, slug));
      const member = new Browser(t.app);
      const memberEmail = uniqueEmail();
      await member.submit("/signup", "/signup", { name: "Member", email: memberEmail, password: PASSWORD });

      expect((await admin.submit("/admin", `/admin/perks/${perk!.id}/grant`, { email: "nobody@example.test" })).body).toContain("No Kingdom account");
      expect((await admin.submit("/admin", `/admin/perks/${perk!.id}/grant`, { email: memberEmail })).statusCode).toBe(303);
      expect((await t.ctx.perks.claimFor(await userId(memberEmail))).map((p) => p.id)).toContain(slug);

      await admin.submit("/admin", `/admin/perks/${perk!.id}/toggle`, {});
      expect((await t.ctx.perks.claimFor(await userId(memberEmail))).map((p) => p.id)).not.toContain(slug);

      await admin.submit("/admin", `/admin/perks/${perk!.id}/delete`, {});
      expect(await t.ctx.db.select().from(perksTable).where(eq(perksTable.slug, slug))).toHaveLength(0);
    });

    it("needs CSRF for every change", async () => {
      const admin = await adminBrowser(true);
      expect((await admin.post("/admin/perks", { slug: "x.y", name: "n", description: "d", rule: "manual" })).statusCode).toBe(403);
    });
  });
});
