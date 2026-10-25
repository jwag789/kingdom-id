import { masks, securityEvents, users } from "@kingdom-id/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFirstAddress, parseMessage, headerValue } from "../../src/relay/mime.js";
import { MemoryTransport } from "../../src/relay/transport.js";
import {
  Browser,
  type TestApp,
  authorizeUrl,
  createTestApp,
  location,
  pkce,
  redeem,
  registerClient,
  signUpAndAuthorize,
} from "../helpers.js";
import { FakeSns, email, sesNotification } from "../support/sns.js";

describe("email relay", () => {
  let t: TestApp;
  const transport = new MemoryTransport();
  const sns = new FakeSns();
  const s3 = new Map<string, Buffer>();
  const confirmed: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp(
      { RELAY_SNS_TOPIC_ARN: sns.topicArn },
      {
        relayTransport: transport,
        relayInbound: {
          fetchCert: sns.fetchCert,
          fetchRaw: async (bucket, key) => s3.get(`${bucket}/${key}`)!,
          confirmSubscription: async (url) => void confirmed.push(url),
        },
      },
    );
  });
  afterAll(() => t.close());

  /** A verified user connected to a fresh app with the email scope; returns their mask and the app's access token. */
  async function member(opts: { verified?: boolean } = {}) {
    const app = await registerClient(t.ctx, { name: `Shop ${++seq}` });
    const flow = await signUpAndAuthorize(t.app, app.client, { extra: { scope: "openid email" } });
    const [user] = await t.ctx.db.select().from(users).where(eq(users.email, flow.email));
    if (opts.verified !== false) await t.ctx.users.markEmailVerified(user!.id);
    const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: app.client.id, secret: app.secret! })).json();
    const [mask] = await t.ctx.db.select().from(masks).where(and(eq(masks.userId, user!.id), eq(masks.clientId, app.client.id)));
    return { app, flow, user: user!, mask: mask!, tokens };
  }

  const userinfo = async (token: string) =>
    (await t.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${token}` } })).json();

  /** Delivers mail the way production does: SES → SNS → our endpoint. */
  async function deliver(raw: Buffer, recipients: string[], extra: Parameters<typeof sesNotification>[0]["verdicts"] = {}, opts: { messageId?: string; dmarcPolicy?: string } = {}) {
    const before = transport.sent.length;
    const message = sesNotification({ messageId: opts.messageId ?? `ses-${Math.random()}`, recipients, raw, verdicts: extra, ...(opts.dmarcPolicy ? { dmarcPolicy: opts.dmarcPolicy } : {}) });
    const res = await t.app.inject({
      method: "POST",
      url: "/relay/sns",
      headers: { "content-type": "text/plain; charset=UTF-8" },
      payload: JSON.stringify(sns.envelope("Notification", message)),
    });
    expect(res.statusCode).toBe(200);
    return transport.sent.slice(before);
  }

  describe("addresses", () => {
    it("creates a private address on first consent and releases it as the email claim", async () => {
      const { tokens, mask, user } = await member();
      expect(mask.address).toMatch(/@relay\.localhost$/);
      const info = await userinfo(tokens.access_token);
      expect(info.email).toBe(mask.address);
      expect(info.email).not.toBe(user.email);
      expect(info.email_verified).toBe(true);
      // Stable across reads.
      expect((await userinfo(tokens.access_token)).email).toBe(mask.address);
    });

    it("gives each app its own address", async () => {
      const first = await member();
      const other = await registerClient(t.ctx);
      const { verifier, challenge } = pkce();
      const start = await first.flow.browser.get(
        authorizeUrl({ client_id: other.client.id, redirect_uri: other.client.redirectUris[0]!, scope: "openid email", code_challenge: challenge, code_challenge_method: "S256" }),
      );
      const interaction = location(start).pathname;
      const consent = await first.flow.browser.submit(interaction, `${interaction}/consent`, { decision: "allow" });
      const code = location(consent).searchParams.get("code")!;
      const tokens = (await redeem(t.app, { code, redirect_uri: other.client.redirectUris[0]!, code_verifier: verifier }, { id: other.client.id, secret: other.secret! })).json();
      const otherEmail = (await userinfo(tokens.access_token)).email;
      expect(otherEmail).toMatch(/@relay\.localhost$/);
      expect(otherEmail).not.toBe(first.mask.address);
    });

    it("issues no address to an app that never asked for email", async () => {
      const app = await registerClient(t.ctx);
      const flow = await signUpAndAuthorize(t.app, app.client, { extra: { scope: "openid profile" } });
      const [user] = await t.ctx.db.select().from(users).where(eq(users.email, flow.email));
      expect(await t.ctx.db.select().from(masks).where(eq(masks.userId, user!.id))).toHaveLength(0);
    });

    it("replaces a deleted address with a new one, and never reissues the old one", async () => {
      const { tokens, mask, user } = await member();
      await t.ctx.relay.remove(user.id, mask.id);
      const fresh = (await userinfo(tokens.access_token)).email;
      expect(fresh).not.toBe(mask.address);
      const [tombstone] = await t.ctx.db.select().from(masks).where(eq(masks.address, mask.address));
      expect(tombstone!.status).toBe("deleted");
    });

    it("releases the real address when the relay is switched off", async () => {
      const plain = await createTestApp({ EMAIL_RELAY_ENABLED: "false" });
      const app = await registerClient(plain.ctx);
      const flow = await signUpAndAuthorize(plain.app, app.client, { extra: { scope: "openid email" } });
      const tokens = (await redeem(plain.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: app.client.id, secret: app.secret! })).json();
      expect((await plain.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${tokens.access_token}` } })).json().email).toBe(flow.email);
      expect((await plain.app.inject({ method: "POST", url: "/relay/sns", payload: "{}" })).statusCode).toBe(404);
      await plain.close();
    });
  });

  describe("forwarding", () => {
    it("forwards to the real inbox with replies routed back through the relay", async () => {
      const { mask, user } = await member();
      const raw = email({ from: '"Shop Support" <support@shop.test>', to: mask.address, extraHeaders: ["List-Unsubscribe: <mailto:unsub@shop.test>"] });
      const [sent] = await deliver(raw, [mask.address]);
      expect(sent!.to).toBe(user.email);

      const out = parseMessage(sent!.raw);
      const from = parseFirstAddress(headerValue(out, "From"))!;
      expect(from.address).toMatch(/^r\.[a-z2-9]{16}@relay\.localhost$/);
      expect(from.name).toBe("Shop Support (support@shop.test) via Kingdom");
      expect(headerValue(out, "Reply-To")).toBe(from.address);
      expect(headerValue(out, "X-Kingdom-Original-From")).toBe('"Shop Support" <support@shop.test>');
      expect(headerValue(out, "DKIM-Signature")).toBeUndefined();
      expect(headerValue(out, "List-Unsubscribe")).toBeUndefined();
      expect(headerValue(out, "Subject")).toBe("Hello");
      expect(out.body.toString()).toBe("Hi there.\r\n");

      const [counted] = await t.ctx.db.select().from(masks).where(eq(masks.id, mask.id));
      expect(counted!.forwardedCount).toBe(1);
    });

    it("sends the user's reply out from the private address, never the real one", async () => {
      const { mask, user } = await member();
      const [forwarded] = await deliver(email({ from: "support@shop.test", to: mask.address }), [mask.address]);
      const alias = parseFirstAddress(headerValue(parseMessage(forwarded!.raw), "Reply-To"))!.address;

      const reply = email({
        from: `"${user.name}" <${user.email}>`,
        to: alias,
        subject: "Re: Hello",
        extraHeaders: [`Cc: ${user.email}`, "In-Reply-To: <m1@sender.test>"],
        body: "Thanks!\r\n",
      });
      const [sent] = await deliver(reply, [alias]);
      expect(sent!.to).toBe("support@shop.test");
      expect(sent!.from).toBe(mask.address);
      const out = parseMessage(sent!.raw);
      expect(headerValue(out, "From")).toBe(mask.address);
      expect(headerValue(out, "To")).toBe("support@shop.test");
      expect(headerValue(out, "Cc")).toBeUndefined();
      expect(headerValue(out, "In-Reply-To")).toBe("<m1@sender.test>");
      expect(sent!.raw.toString()).not.toContain(user.email);
    });

    it("refuses replies that don't authenticate as the owner, and tells them", async () => {
      const { mask, user } = await member();
      const [forwarded] = await deliver(email({ from: "support@shop.test", to: mask.address }), [mask.address]);
      const alias = parseFirstAddress(headerValue(parseMessage(forwarded!.raw), "Reply-To"))!.address;

      // Someone else, and a forgery of the owner's address that fails SPF, DKIM and DMARC.
      expect(await deliver(email({ from: "mallory@evil.test", to: alias }), [alias])).toHaveLength(0);
      expect(await deliver(email({ from: user.email, to: alias }), [alias], { spf: "FAIL", dkim: "FAIL", dmarc: "FAIL" })).toHaveLength(0);

      const events = await t.ctx.db.select().from(securityEvents).where(and(eq(securityEvents.userId, user.id), eq(securityEvents.type, "relay_spoof_blocked")));
      expect(events).toHaveLength(2);
    });

    it("holds mail until the owner has verified their address", async () => {
      const { mask } = await member({ verified: false });
      expect(await deliver(email({ from: "a@shop.test", to: mask.address }), [mask.address])).toHaveLength(0);
      const [row] = await t.ctx.db.select().from(masks).where(eq(masks.id, mask.id));
      expect(row!.blockedCount).toBe(1);
    });

    it("drops mail to paused and deleted addresses, and resumes when unpaused", async () => {
      const { mask, user } = await member();
      await t.ctx.relay.setForwarding(user.id, mask.id, false);
      expect(await deliver(email({ from: "a@shop.test", to: mask.address }), [mask.address])).toHaveLength(0);
      await t.ctx.relay.setForwarding(user.id, mask.id, true);
      expect(await deliver(email({ from: "a@shop.test", to: mask.address }), [mask.address])).toHaveLength(1);
      await t.ctx.relay.remove(user.id, mask.id);
      expect(await deliver(email({ from: "a@shop.test", to: mask.address }), [mask.address])).toHaveLength(0);
    });

    it("drops viruses, spam, DMARC rejects, relay loops and unknown addresses", async () => {
      const { mask } = await member();
      const msg = () => email({ from: "a@shop.test", to: mask.address });
      expect(await deliver(msg(), [mask.address], { virus: "FAIL" })).toHaveLength(0);
      expect(await deliver(msg(), [mask.address], { spam: "FAIL" })).toHaveLength(0);
      expect(await deliver(msg(), [mask.address], { dmarc: "FAIL" }, { dmarcPolicy: "REJECT" })).toHaveLength(0);
      expect(await deliver(email({ from: "x.abc@relay.localhost", to: mask.address }), [mask.address])).toHaveLength(0);
      expect(await deliver(msg(), ["nobody.zzzzzz@relay.localhost"])).toHaveLength(0);
      // DMARC failure without a reject policy still arrives.
      expect(await deliver(msg(), [mask.address], { dmarc: "FAIL" }, { dmarcPolicy: "none" })).toHaveLength(1);
    });

    it("processes a redelivered message once", async () => {
      const { mask } = await member();
      const raw = email({ from: "a@shop.test", to: mask.address });
      expect(await deliver(raw, [mask.address], {}, { messageId: "same-id" })).toHaveLength(1);
      expect(await deliver(raw, [mask.address], {}, { messageId: "same-id" })).toHaveLength(0);
    });

    it("reads large messages from S3 when SES stored them there", async () => {
      const { mask, user } = await member();
      s3.set("inbound-bucket/msg-1", email({ from: "big@shop.test", to: mask.address, body: "x".repeat(200_000) }));
      const message = sesNotification({ messageId: "s3-1", recipients: [mask.address], s3: { bucket: "inbound-bucket", key: "msg-1" } });
      const before = transport.sent.length;
      const res = await t.app.inject({ method: "POST", url: "/relay/sns", headers: { "content-type": "text/plain" }, payload: JSON.stringify(sns.envelope("Notification", message)) });
      expect(res.statusCode).toBe(200);
      expect(transport.sent.slice(before)[0]!.to).toBe(user.email);
    });
  });

  describe("SNS endpoint", () => {
    const post = (body: unknown) =>
      t.app.inject({ method: "POST", url: "/relay/sns", headers: { "content-type": "text/plain" }, payload: JSON.stringify(body) });

    it("accepts both signature versions", async () => {
      const { mask } = await member();
      const msg = sesNotification({ messageId: `v1-${Math.random()}`, recipients: [mask.address], raw: email({ from: "a@shop.test", to: mask.address }) });
      expect((await post(sns.envelope("Notification", msg, {}, "1"))).statusCode).toBe(200);
    });

    it("rejects forged, foreign-topic and off-Amazon certificate messages", async () => {
      const msg = sesNotification({ messageId: "x", recipients: [], raw: Buffer.from("x") });
      expect((await post(sns.envelope("Notification", msg, { Signature: Buffer.alloc(256, 1).toString("base64") }))).statusCode).toBe(403);
      expect((await post(sns.envelope("Notification", msg, { TopicArn: "arn:aws:sns:us-east-1:999999999999:other" }))).statusCode).toBe(403);
      expect((await post(sns.envelope("Notification", msg, { SigningCertURL: "https://evil.example.com/cert.pem" }))).statusCode).toBe(403);
      expect((await post({ hello: "world" })).statusCode).toBe(403);
    });

    it("confirms the subscription only for Amazon's own SubscribeURL", async () => {
      expect((await post(sns.envelope("SubscriptionConfirmation", "confirm"))).statusCode).toBe(200);
      expect(confirmed).toContain("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t");
      const evil = sns.envelope("SubscriptionConfirmation", "confirm", { SubscribeURL: "https://evil.example.com/?x=1" });
      expect((await post(evil)).statusCode).toBe(400);
      expect(confirmed).not.toContain("https://evil.example.com/?x=1");
    });
  });

  describe("Masks controls", () => {
    it("pauses, resumes and deletes from the dashboard, only for the owner", async () => {
      const { mask, flow } = await member();
      const pause = await flow.browser.submit("/account/masks", `/account/masks/${mask.id}/disable`, {});
      expect(pause.statusCode).toBe(303);
      expect((await t.ctx.db.select().from(masks).where(eq(masks.id, mask.id)))[0]!.status).toBe("disabled");
      expect((await flow.browser.get("/account/masks")).body).toContain("Resume forwarding");

      await flow.browser.submit("/account/masks", `/account/masks/${mask.id}/enable`, {});
      expect((await t.ctx.db.select().from(masks).where(eq(masks.id, mask.id)))[0]!.status).toBe("active");

      const intruder = await member();
      await intruder.flow.browser.submit("/account/masks", `/account/masks/${mask.id}/delete`, {});
      expect((await t.ctx.db.select().from(masks).where(eq(masks.id, mask.id)))[0]!.status).toBe("active");

      await flow.browser.submit("/account/masks", `/account/masks/${mask.id}/delete`, {});
      expect((await t.ctx.db.select().from(masks).where(eq(masks.id, mask.id)))[0]!.status).toBe("deleted");
      const tower = (await flow.browser.get("/account/watchtower")).body;
      expect(tower).toContain("Paused forwarding");
      expect(tower).toContain("Deleted");
    });

    it("needs CSRF", async () => {
      const { mask, flow } = await member();
      expect((await flow.browser.post(`/account/masks/${mask.id}/delete`, {})).statusCode).toBe(403);
      void Browser;
    });
  });
});
