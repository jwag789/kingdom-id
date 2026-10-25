import { alerts, securityEvents, users } from "@kingdom-id/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SecurityEventEnvelope } from "../../src/security/pipeline/events.js";
import { EventStream } from "../../src/security/pipeline/stream.js";
import { Browser, ISSUER, PASSWORD, type TestApp, clientPost, createTestApp, redeem, registerClient, signUpAndAuthorize, uniqueEmail } from "../helpers.js";
import { SoftAuthenticator } from "../support/authenticator.js";

const quiet = { error: () => {}, warn: () => {} };

describe("security event pipeline", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const event = (overrides: Partial<SecurityEventEnvelope> = {}): SecurityEventEnvelope => ({
    id: crypto.randomUUID(),
    type: "signed_out",
    at: new Date().toISOString(),
    details: {},
    ...overrides,
  });
  const persisted = async (id: string) => (await t.ctx.db.select().from(securityEvents).where(eq(securityEvents.id, id))).length;

  describe("stream mechanics", () => {
    it("publishes without writing; the consumer persists", async () => {
      const e = event();
      await t.ctx.eventStream.publish(e);
      expect(await persisted(e.id)).toBe(0);
      await t.ctx.eventStream.drain();
      expect(await persisted(e.id)).toBe(1);
    });

    it("persists a redelivered event once", async () => {
      const e = event();
      await t.ctx.eventStream.publish(e);
      await t.ctx.eventStream.publish(e);
      await t.ctx.eventStream.drain();
      expect(await persisted(e.id)).toBe(1);
    });

    it("splits work across consumers in the group, each event handled once", async () => {
      const key = `pipeline-test-${crypto.randomUUID()}`;
      const handled: string[] = [];
      const consumers = [1, 2, 3].map(() => new EventStream(t.ctx.redis, key, 1000, async (e) => void handled.push(e.id), quiet));
      await Promise.all(consumers.map((c) => c.start()));
      const ids = Array.from({ length: 30 }, () => crypto.randomUUID());
      for (const id of ids) await consumers[0]!.publish(event({ id }));
      await consumers[0]!.drain();
      await Promise.all(consumers.map((c) => c.stop()));
      expect(handled.sort()).toEqual(ids.sort());
    });

    it("recovers entries a crashed consumer read but never acknowledged", async () => {
      const key = `pipeline-test-${crypto.randomUUID()}`;
      const handled: string[] = [];
      const stream = new EventStream(t.ctx.redis, key, 1000, async (e) => void handled.push(e.id), quiet);
      await stream.ensureGroup();
      const e = event();
      await stream.publish(e);
      // A consumer reads the entry, then dies before acknowledging it.
      await t.ctx.redis.call("XREADGROUP", "GROUP", "persist-and-detect", "doomed-consumer", "COUNT", 10, "STREAMS", key, ">");
      expect((await stream.health()).pending).toBe(1);
      await stream.drain();
      expect(handled).toEqual([e.id]);
      expect((await stream.health()).pending).toBe(0);
    });

    it("dead-letters an event that keeps failing, and keeps going", async () => {
      const key = `pipeline-test-${crypto.randomUUID()}`;
      const handled: string[] = [];
      const poison = event();
      const stream = new EventStream(
        t.ctx.redis,
        key,
        1000,
        async (e) => {
          if (e.id === poison.id) throw new Error("cannot process");
          handled.push(e.id);
        },
        quiet,
      );
      const good = event();
      await stream.publish(poison);
      await stream.publish(good);
      await stream.drain();
      expect(handled).toEqual([good.id]);
      const health = await stream.health();
      expect(health.deadLetters).toBe(1);
      expect(health.pending).toBe(0);
    });
  });

  describe("detection rules", () => {
    const alertsFor = async (userId: string) => t.ctx.db.select().from(alerts).where(eq(alerts.userId, userId));

    async function account(ip = "198.51.100.10") {
      const email = uniqueEmail();
      const browser = new Browser(t.app, ip);
      await browser.submit("/signup", "/signup", { name: "Rule Tester", email, password: PASSWORD });
      const [user] = await t.ctx.db.select().from(users).where(eq(users.email, email));
      return { email, user: user!, browser };
    }

    it("raises one alert for a failed sign-in burst on an account", async () => {
      const { email, user } = await account();
      for (let i = 0; i < 7; i++) {
        await new Browser(t.app, `192.0.2.${i + 1}`).submit("/login", "/login", { email, password: "wrong password!!" });
      }
      await t.ctx.eventStream.drain();
      const raised = (await alertsFor(user.id)).filter((a) => a.rule === "failed_login_burst");
      expect(raised).toHaveLength(1);
      expect(raised[0]!.severity).toBe("high");
      expect((await new Browser(t.app).get("/account")).statusCode).toBe(303); // sanity: unrelated browser
    });

    it("raises a credential-stuffing alert for many failures from one IP across accounts", async () => {
      const ip = "203.0.113.66";
      for (let i = 0; i < 21; i++) {
        await new Browser(t.app, ip).submit("/login", "/login", { email: `stuffed-${i}-${Math.random()}@example.test`, password: "guess" + i });
      }
      await t.ctx.eventStream.drain();
      const raised = await t.ctx.db
        .select()
        .from(alerts)
        .where(and(eq(alerts.rule, "credential_stuffing"), eq(alerts.ip, ip)));
      expect(raised).toHaveLength(1);
      expect(raised[0]!.severity).toBe("critical");
      expect(raised[0]!.userId).toBeNull();
    });

    it("raises a critical alert for refresh token reuse", async () => {
      const app = await registerClient(t.ctx);
      const flow = await signUpAndAuthorize(t.app, app.client, { extra: { scope: "openid offline_access" } });
      const auth = { id: app.client.id, secret: app.secret! };
      const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, auth)).json();
      await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, auth);
      await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, auth);
      await t.ctx.eventStream.drain();
      const [user] = await t.ctx.db.select().from(users).where(eq(users.email, flow.email));
      const raised = (await alertsFor(user!.id)).filter((a) => a.rule === "refresh_token_reuse");
      expect(raised).toHaveLength(1);
      expect(raised[0]!).toMatchObject({ severity: "critical", clientId: app.client.id });
    });

    it("flags a sign-in from a new network, once, and never the first one", async () => {
      const { email, user } = await account("198.51.100.10");
      // Same /24 as the signup: familiar.
      await new Browser(t.app, "198.51.100.99").submit("/login", "/login", { email, password: PASSWORD });
      await t.ctx.eventStream.drain();
      expect(await alertsFor(user.id)).toHaveLength(0);

      // A different network: flagged, and shown to the member.
      const away = new Browser(t.app, "192.0.2.44");
      await away.submit("/login", "/login", { email, password: PASSWORD });
      await new Browser(t.app, "192.0.2.45").submit("/login", "/login", { email, password: PASSWORD });
      await t.ctx.eventStream.drain();
      const raised = (await alertsFor(user.id)).filter((a) => a.rule === "new_network");
      expect(raised).toHaveLength(1);
      expect(raised[0]!.details).toMatchObject({ network: "192.0.2.0/24" });
      expect((await away.get("/account/watchtower")).body).toContain("a network you haven");
    });

    it("flags a new country from a trusted CDN header, and ignores the header when proxies aren't trusted", async () => {
      const trusting = await createTestApp({ TRUST_PROXY: "true" });
      const email = uniqueEmail();
      // Behind a trusted proxy the client IP comes from X-Forwarded-For.
      const us = { "x-forwarded-for": "198.51.100.20", "cf-ipcountry": "US" };
      await new Browser(trusting.app, "10.0.0.1", us).submit("/signup", "/signup", { name: "Traveler", email, password: PASSWORD });
      await new Browser(trusting.app, "10.0.0.1", { "x-forwarded-for": "198.51.100.21", "cf-ipcountry": "DE" }).submit("/login", "/login", { email, password: PASSWORD });
      await trusting.ctx.eventStream.drain();
      const [user] = await trusting.ctx.db.select().from(users).where(eq(users.email, email));
      const raised = await trusting.ctx.db.select().from(alerts).where(eq(alerts.userId, user!.id));
      expect(raised.map((a) => a.rule)).toEqual(["new_country"]);
      expect(raised[0]!.details).toMatchObject({ country: "DE" });
      await trusting.close();

      // Without trusted proxies, anyone could send the header, so it's ignored.
      const { email: e2, user: u2 } = await account("198.51.100.30");
      await new Browser(t.app, "198.51.100.31", { "cf-ipcountry": "KP" }).submit("/login", "/login", { email: e2, password: PASSWORD });
      await t.ctx.eventStream.drain();
      const [signIn] = await t.ctx.db.select().from(securityEvents).where(and(eq(securityEvents.userId, u2.id), eq(securityEvents.type, "sign_in")));
      expect((signIn!.details as Record<string, unknown>).country).toBeUndefined();
    });
  });

  describe("admin alerts view", () => {
    async function admin() {
      const browser = new Browser(t.app);
      const email = uniqueEmail();
      const authenticator = new SoftAuthenticator(ISSUER);
      const csrf = await browser.csrf("/signup");
      const options = (await browser.json("/passkeys/register/options", { csrf, mode: "signup", name: "Admin", email })).json();
      await browser.json("/passkeys/register", { csrf, response: authenticator.create(options) });
      await t.ctx.db.update(users).set({ isAdmin: true }).where(eq(users.email, email));
      return browser;
    }

    it("lists open alerts with pipeline health, and acknowledges them", async () => {
      const ip = "203.0.113.200";
      for (let i = 0; i < 21; i++) await new Browser(t.app, ip).submit("/login", "/login", { email: `ack-${i}-${Math.random()}@example.test`, password: "x" });
      await t.ctx.eventStream.drain();
      const [alert] = await t.ctx.db.select().from(alerts).where(and(eq(alerts.rule, "credential_stuffing"), eq(alerts.ip, ip)));

      const browser = await admin();
      const page = await browser.get("/admin/alerts");
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("Credential stuffing");
      expect(page.body).toContain(ip);
      expect(page.body).toContain("Dead letters");

      await browser.submit("/admin/alerts", `/admin/alerts/${alert!.id}/ack`, {});
      const [acked] = await t.ctx.db.select().from(alerts).where(eq(alerts.id, alert!.id));
      expect(acked!.acknowledgedAt).toBeInstanceOf(Date);
      expect((await browser.get("/admin/alerts")).body).not.toContain(`/admin/alerts/${alert!.id}/ack`);
      expect((await browser.get("/admin/alerts?filter=all")).body).toContain("Acknowledged");
    });

    it("is closed to members", async () => {
      const member = new Browser(t.app);
      await member.submit("/signup", "/signup", { name: "M", email: uniqueEmail(), password: PASSWORD });
      expect((await member.get("/admin/alerts")).statusCode).toBe(403);
      expect((await member.post("/admin/alerts/00000000-0000-0000-0000-000000000000/ack", {})).statusCode).toBe(403);
    });
  });
});
