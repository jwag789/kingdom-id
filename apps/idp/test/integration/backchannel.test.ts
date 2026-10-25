import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKCHANNEL_LOGOUT_EVENT } from "../../src/oauth/backchannel.js";
import { ISSUER, type TestApp, clientPost, createTestApp, redeem, registerClient, signUpAndAuthorize } from "../helpers.js";

/** A stand-in app: records logout tokens, and answers with whatever status the test queues. */
class Receiver {
  readonly tokens: string[] = [];
  readonly statuses: number[] = [];
  private server!: Server;
  url = "";

  async start() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const status = this.statuses.shift() ?? 200;
        if (status === 200) this.tokens.push(new URLSearchParams(body).get("logout_token") ?? "");
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/backchannel-logout`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe("OIDC Back-Channel Logout", () => {
  let t: TestApp;
  const receiver = new Receiver();
  beforeAll(async () => {
    t = await createTestApp();
    await receiver.start();
  });
  afterAll(async () => {
    await receiver.stop();
    await t.close();
  });

  const settle = () => t.ctx.logoutStream.drain();
  const jwks = async () => createLocalJWKSet((await t.app.inject("/.well-known/jwks.json")).json());

  /** Verifies a logout token exactly as an app must (OIDC Back-Channel Logout 1.0 §2.6). */
  async function verifyLogoutToken(token: string, clientId: string) {
    const { payload, protectedHeader } = await jwtVerify(token, await jwks(), { issuer: ISSUER, audience: clientId, typ: "logout+jwt" });
    expect(payload.events).toEqual({ [BACKCHANNEL_LOGOUT_EVENT]: {} });
    expect(payload.nonce).toBeUndefined();
    expect(payload.jti).toBeTypeOf("string");
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(120);
    return { payload, protectedHeader };
  }

  async function signedIn(extra: Record<string, string> = {}) {
    const app = await registerClient(t.ctx, { backchannelLogoutUri: receiver.url, redirectUris: ["http://127.0.0.1:9/cb"] });
    const flow = await signUpAndAuthorize(t.app, app.client, { extra });
    const tokens = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: app.client.id, secret: app.secret! })).json();
    return { app, flow, tokens, idToken: decodeJwt(tokens.id_token) };
  }

  it("advertises support in discovery", async () => {
    const doc = (await t.app.inject("/.well-known/openid-configuration")).json();
    expect(doc.backchannel_logout_supported).toBe(true);
    expect(doc.backchannel_logout_session_supported).toBe(true);
  });

  it("tells the app when the user signs out of Kingdom, naming the exact session", async () => {
    const { app, flow, idToken } = await signedIn();
    const before = receiver.tokens.length;
    await flow.browser.submit("/account", "/logout", {});
    await settle();
    const [token] = receiver.tokens.slice(before);
    const { payload } = await verifyLogoutToken(token!, app.client.id);
    // The sid and sub match the ID token the app holds, so it knows which session to end.
    expect(payload.sid).toBe(idToken.sid);
    expect(payload.sub).toBe(idToken.sub);
  });

  it("tells the app when the user disconnects it, ending every session there", async () => {
    const { app, flow, idToken } = await signedIn();
    const before = receiver.tokens.length;
    await flow.browser.submit("/account", `/account/realms/${app.client.id}/disconnect`, {});
    await settle();
    const [token] = receiver.tokens.slice(before);
    const { payload } = await verifyLogoutToken(token!, app.client.id);
    expect(payload.sub).toBe(idToken.sub);
    expect(payload.sid).toBeUndefined();
  });

  it("tells the app when its refresh token is stolen and replayed", async () => {
    const { app, tokens, idToken } = await signedIn({ scope: "openid offline_access" });
    const auth = { id: app.client.id, secret: app.secret! };
    await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, auth);
    const before = receiver.tokens.length;
    await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, auth);
    await settle();
    const { payload } = await verifyLogoutToken(receiver.tokens.slice(before)[0]!, app.client.id);
    expect(payload.sub).toBe(idToken.sub);
    expect(payload.sid).toBe(idToken.sid);
  });

  it("retries when the app is briefly down, with a freshly signed token", async () => {
    const { app, flow } = await signedIn();
    const before = receiver.tokens.length;
    receiver.statuses.push(503, 500); // two failures, then success
    await flow.browser.submit("/account", "/logout", {});
    await settle();
    expect(receiver.tokens.length - before).toBe(1);
    await verifyLogoutToken(receiver.tokens.at(-1)!, app.client.id);
  });

  it("dead-letters a notice the app never accepts, without blocking others", async () => {
    const { flow } = await signedIn();
    receiver.statuses.push(500, 500, 500, 500, 500);
    const deadBefore = (await t.ctx.logoutStream.health()).deadLetters;
    await flow.browser.submit("/account", "/logout", {});
    await settle();
    expect((await t.ctx.logoutStream.health()).deadLetters).toBe(deadBefore + 1);

    // The next notice still goes through.
    const { flow: next } = await signedIn();
    const before = receiver.tokens.length;
    await next.browser.submit("/account", "/logout", {});
    await settle();
    expect(receiver.tokens.length).toBe(before + 1);
  });

  it("sends nothing to apps that didn't register a back-channel URI", async () => {
    const plain = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, plain.client);
    await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: plain.client.id, secret: plain.secret! });
    const before = receiver.tokens.length;
    await flow.browser.submit("/account", "/logout", {});
    await settle();
    expect(receiver.tokens.length).toBe(before);
  });

  it("rejects a back-channel URI that isn't https or loopback", async () => {
    await expect(registerClient(t.ctx, { backchannelLogoutUri: "http://app.example.com/logout" })).rejects.toThrow(/https/);
  });
});

