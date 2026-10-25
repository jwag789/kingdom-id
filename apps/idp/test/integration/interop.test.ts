import { createServer } from "node:net";
import * as oidc from "openid-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, type TestApp, createTestApp, csrfFrom, registerClient, uniqueEmail } from "../helpers.js";

/**
 * Runs the flow over real HTTP with openid-client, an independent certified
 * relying-party library. If it accepts our discovery document, authorization
 * response, tokens and userinfo, we're interoperable, not just self-consistent.
 */
describe("interop with openid-client", () => {
  let t: TestApp;
  let issuer: string;

  beforeAll(async () => {
    const port = await freePort();
    issuer = `http://localhost:${port}`;
    t = await createTestApp({ ISSUER: issuer });
    await t.app.listen({ port, host: "localhost" });
  });
  afterAll(() => t.close());

  it("completes discovery, authorization, token exchange and userinfo", async () => {
    const { client, secret } = await registerClient(t.ctx, {
      redirectUris: ["http://localhost:9/callback"],
      postLogoutRedirectUris: ["http://localhost:9/"],
    });
    const config = await oidc.discovery(
      new URL(issuer),
      client.id,
      { client_secret: secret! },
      oidc.ClientSecretBasic(secret!),
      { execute: [oidc.allowInsecureRequests] },
    );

    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: client.redirectUris[0]!,
      scope: "openid profile email offline_access",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });

    // Play the browser: follow redirects by hand, keeping cookies.
    const jar = new Map<string, string>();
    const go = async (url: string, form?: Record<string, string>) => {
      const res = await fetch(new URL(url, issuer), {
        method: form ? "POST" : "GET",
        redirect: "manual",
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(form ? { body: new URLSearchParams(form) } : {}),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const [k, v] = pair!.split("=");
        jar.set(k!, v!);
      }
      return { res, body: await res.text(), location: res.headers.get("location") };
    };

    const start = await go(authUrl.href);
    const interaction = start.location!;
    const signupPage = await go(`${interaction}/signup`);
    const email = uniqueEmail();
    await go(`${interaction}/signup`, { csrf: csrfFrom(signupPage.body), name: "Interop", email, password: PASSWORD });
    const consentPage = await go(interaction);
    const consent = await go(`${interaction}/consent`, { csrf: csrfFrom(consentPage.body), decision: "allow" });
    const callback = new URL(consent.location!);

    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims()!;
    expect(claims.iss).toBe(issuer);

    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    expect(userinfo).toMatchObject({ sub: claims.sub, email, name: "Interop" });

    // Token lifecycle: refresh (with rotation), introspection, revocation.
    const refreshed = await oidc.refreshTokenGrant(config, tokens.refresh_token!);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(refreshed.claims()!.sub).toBe(claims.sub);
    expect(await oidc.tokenIntrospection(config, refreshed.access_token)).toMatchObject({ active: true, sub: claims.sub });
    await oidc.tokenRevocation(config, refreshed.refresh_token!);
    expect(await oidc.tokenIntrospection(config, refreshed.access_token)).toMatchObject({ active: false });

    // RP-initiated logout with the library's own end-session URL.
    const endSession = oidc.buildEndSessionUrl(config, {
      id_token_hint: tokens.id_token!,
      post_logout_redirect_uri: "http://localhost:9/",
      state: "done",
    });
    const logout = await go(endSession.href);
    expect(logout.location).toBe("http://localhost:9/?state=done");
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
