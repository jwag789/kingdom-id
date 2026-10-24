import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Browser,
  type TestApp,
  authorizeUrl,
  clientPost,
  createTestApp,
  csrfFrom,
  location,
  pkce,
  redeem,
  registerClient,
  signUpAndAuthorize,
} from "../helpers.js";

describe("logout", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  /** Two apps signed in through one browser: one online, one with offline_access. */
  async function signedIn() {
    const host = `logout-${Math.random().toString(36).slice(2, 8)}.example.test`;
    const online = await registerClient(t.ctx, {
      redirectUris: [`https://${host}/callback`],
      postLogoutRedirectUris: [`https://${host}/signed-out`],
    });
    const offline = await registerClient(t.ctx);
    const flow = await signUpAndAuthorize(t.app, online.client, { extra: { scope: "openid email" } });
    const onlineTokens = (
      await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: online.client.id, secret: online.secret! })
    ).json();

    const p = pkce();
    const start = await flow.browser.get(
      authorizeUrl({
        client_id: offline.client.id,
        redirect_uri: offline.client.redirectUris[0]!,
        scope: "openid offline_access",
        code_challenge: p.challenge,
        code_challenge_method: "S256",
      }),
    );
    const interaction = location(start).pathname;
    const consent = await flow.browser.submit(interaction, `${interaction}/consent`, { decision: "allow" });
    const offlineTokens = (
      await redeem(
        t.app,
        { code: location(consent).searchParams.get("code")!, redirect_uri: offline.client.redirectUris[0]!, code_verifier: p.verifier },
        { id: offline.client.id, secret: offline.secret! },
      )
    ).json();
    return { online, offline, flow, onlineTokens, offlineTokens, signedOutUri: `https://${host}/signed-out` };
  }

  const userinfo = (token: string) => t.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${token}` } });
  const sessionAlive = async (browser: Browser, client: { id: string; redirectUris: string[] }) => {
    const res = await browser.get(
      authorizeUrl({ client_id: client.id, redirect_uri: client.redirectUris[0]!, code_challenge: pkce().challenge, code_challenge_method: "S256", prompt: "none" }),
    );
    return location(res).searchParams.get("error") !== "login_required";
  };

  it("signs out immediately when the app's id_token_hint matches the session, and redirects with state", async () => {
    const s = await signedIn();
    const res = await s.flow.browser.get(
      `/end-session?${new URLSearchParams({ id_token_hint: s.onlineTokens.id_token, post_logout_redirect_uri: s.signedOutUri, state: "bye" })}`,
    );
    expect(res.statusCode).toBe(303);
    const url = location(res);
    expect(url.origin + url.pathname).toBe(s.signedOutUri);
    expect(url.searchParams.get("state")).toBe("bye");
    expect(await sessionAlive(s.flow.browser, s.online.client)).toBe(false);
  });

  it("revokes online grants but keeps offline ones (OIDC Core §11)", async () => {
    const s = await signedIn();
    await s.flow.browser.get(`/end-session?${new URLSearchParams({ id_token_hint: s.onlineTokens.id_token })}`);
    expect((await userinfo(s.onlineTokens.access_token)).statusCode).toBe(401);
    expect((await userinfo(s.offlineTokens.access_token)).statusCode).toBe(200);
    const refreshed = await clientPost(
      t.app,
      "/token",
      { grant_type: "refresh_token", refresh_token: s.offlineTokens.refresh_token },
      { id: s.offline.client.id, secret: s.offline.secret! },
    );
    expect(refreshed.statusCode).toBe(200);
    // It still names the session the grant was made in, as OIDC Core §12.2 asks.
    expect(decodeJwt(refreshed.json().id_token).sid).toBe(decodeJwt(s.offlineTokens.id_token).sid);
  });

  it("asks for confirmation without a matching hint, so a link can't sign you out", async () => {
    const s = await signedIn();
    const page = await s.flow.browser.get(
      `/end-session?${new URLSearchParams({ client_id: s.online.client.id, post_logout_redirect_uri: s.signedOutUri, state: "x" })}`,
    );
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Sign out of Kingdom?");
    expect(page.headers["content-security-policy"]).toContain(`form-action 'self' https://`);
    expect(await sessionAlive(s.flow.browser, s.online.client)).toBe(true);

    const stay = await s.flow.browser.post("/end-session/confirm", {
      csrf: csrfFrom(page.body),
      decision: "stay",
      client_id: s.online.client.id,
      post_logout_redirect_uri: s.signedOutUri,
    });
    expect(location(stay).pathname).toBe("/account");
    expect(await sessionAlive(s.flow.browser, s.online.client)).toBe(true);

    const confirm = await s.flow.browser.post("/end-session/confirm", {
      csrf: csrfFrom(page.body),
      decision: "logout",
      client_id: s.online.client.id,
      post_logout_redirect_uri: s.signedOutUri,
      state: "x",
    });
    expect(location(confirm).searchParams.get("state")).toBe("x");
    expect(await sessionAlive(s.flow.browser, s.online.client)).toBe(false);
  });

  it("treats another session's hint as no hint", async () => {
    const s = await signedIn();
    const other = await signedIn();
    const res = await s.flow.browser.get(`/end-session?${new URLSearchParams({ id_token_hint: other.onlineTokens.id_token })}`);
    expect(res.body).toContain("Sign out of Kingdom?");
  });

  it("never redirects to an unregistered post-logout URI", async () => {
    const s = await signedIn();
    for (const uri of ["https://evil.example.com/", `${s.signedOutUri}/extra`]) {
      const res = await s.flow.browser.get(
        `/end-session?${new URLSearchParams({ id_token_hint: s.onlineTokens.id_token, post_logout_redirect_uri: uri })}`,
      );
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    // Nor when the confirmation form is tampered with.
    const page = await s.flow.browser.get(`/end-session?client_id=${s.online.client.id}`);
    const res = await s.flow.browser.post("/end-session/confirm", {
      csrf: csrfFrom(page.body),
      decision: "logout",
      client_id: s.online.client.id,
      post_logout_redirect_uri: "https://evil.example.com/",
    });
    expect(res.statusCode).toBe(400);
    expect(await sessionAlive(s.flow.browser, s.online.client)).toBe(true);
  });

  it("rejects a client_id that contradicts the hint", async () => {
    const s = await signedIn();
    const res = await s.flow.browser.get(
      `/end-session?${new URLSearchParams({ id_token_hint: s.onlineTokens.id_token, client_id: s.offline.client.id })}`,
    );
    expect(res.statusCode).toBe(400);
  });

  it("requires CSRF on the confirmation", async () => {
    const s = await signedIn();
    const res = await s.flow.browser.post("/end-session/confirm", { decision: "logout" });
    expect(res.statusCode).toBe(403);
    expect(await sessionAlive(s.flow.browser, s.online.client)).toBe(true);
  });

  it("shows a signed-out page when there's no session and nowhere to go", async () => {
    const res = await new Browser(t.app).get("/end-session");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("signed out");
  });

  it("signing out from the account page revokes online grants too", async () => {
    const s = await signedIn();
    await s.flow.browser.submit("/account", "/logout", {});
    expect((await userinfo(s.onlineTokens.access_token)).statusCode).toBe(401);
    expect((await userinfo(s.offlineTokens.access_token)).statusCode).toBe(200);
  });
});
