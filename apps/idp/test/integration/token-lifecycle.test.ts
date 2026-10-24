import { grants, refreshTokens } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type TestApp,
  authorizeUrl,
  clientPost,
  location,
  pkce,
  createTestApp,
  redeem,
  registerClient,
  signUpAndAuthorize,
} from "../helpers.js";

const OFFLINE = { scope: "openid profile email offline_access" };

describe("token lifecycle", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  /** A client and a fresh token response. */
  async function tokensFor(extra: Record<string, string> = OFFLINE, input: Parameters<typeof registerClient>[1] = {}) {
    const { client, secret } = await registerClient(t.ctx, input);
    const auth = { id: client.id, secret: secret! };
    const flow = await signUpAndAuthorize(t.app, client, { extra });
    const res = await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, auth);
    expect(res.statusCode).toBe(200);
    return { client, auth, flow, tokens: res.json() };
  }

  const refresh = (auth: { id: string; secret: string }, refreshToken: string, extra: Record<string, string> = {}) =>
    clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: refreshToken, ...extra }, auth);
  const introspect = (auth: { id: string; secret: string }, token: string) =>
    clientPost(t.app, "/introspect", { token }, auth).then((r) => r.json());
  const userinfo = (accessToken: string) =>
    t.app.inject({ url: "/userinfo", headers: { authorization: `Bearer ${accessToken}` } });

  describe("refresh tokens", () => {
    it("are issued only when offline_access was granted", async () => {
      const online = await tokensFor({ scope: "openid email" });
      expect(online.tokens.refresh_token).toBeUndefined();
      const offline = await tokensFor();
      expect(offline.tokens.refresh_token).toMatch(/^krt_[A-Za-z0-9_-]{43}$/);
    });

    it("rotate on every use, and the new ID token keeps the original auth_time and no nonce", async () => {
      const { auth, tokens } = await tokensFor();
      const res = await refresh(auth, tokens.refresh_token);
      expect(res.statusCode).toBe(200);
      const next = res.json();
      expect(next.refresh_token).toMatch(/^krt_/);
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect(next.access_token).not.toBe(tokens.access_token);

      const before = decodeJwt(tokens.id_token);
      const after = decodeJwt(next.id_token);
      expect(after.sub).toBe(before.sub);
      expect(after.auth_time).toBe(before.auth_time);
      expect(after.nonce).toBeUndefined();
      expect((await userinfo(next.access_token)).statusCode).toBe(200);
    });

    it("detect reuse and revoke the whole family, including live access tokens", async () => {
      const { auth, tokens } = await tokensFor();
      const rotated = (await refresh(auth, tokens.refresh_token)).json();

      // An attacker replays the old token.
      const replay = await refresh(auth, tokens.refresh_token);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe("invalid_grant");

      // Every member of the family is now dead: the legitimate newer refresh
      // token, and access tokens from before and after the rotation.
      expect((await refresh(auth, rotated.refresh_token)).json().error).toBe("invalid_grant");
      expect((await userinfo(rotated.access_token)).statusCode).toBe(401);
      expect((await userinfo(tokens.access_token)).statusCode).toBe(401);
      expect(await introspect(auth, rotated.access_token)).toEqual({ active: false });

      const gid = decodeJwt(tokens.access_token).gid as string;
      const [grant] = await t.ctx.db.select().from(grants).where(eq(grants.id, gid));
      expect(grant!.revokedReason).toBe("refresh_token_reuse");
    });

    it("let only one of two concurrent exchanges win; the loser counts as reuse", async () => {
      const { auth, tokens } = await tokensFor();
      const results = await Promise.all([refresh(auth, tokens.refresh_token), refresh(auth, tokens.refresh_token)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
      const winner = results.find((r) => r.statusCode === 200)!.json();
      expect((await refresh(auth, winner.refresh_token)).json().error).toBe("invalid_grant");
    });

    it("are bound to their client, and a foreign client can't burn the family", async () => {
      const { auth, tokens } = await tokensFor();
      const other = await registerClient(t.ctx);
      const stolen = await refresh({ id: other.client.id, secret: other.secret! }, tokens.refresh_token);
      expect(stolen.json().error).toBe("invalid_grant");
      // The rightful client is unaffected.
      expect((await refresh(auth, tokens.refresh_token)).statusCode).toBe(200);
    });

    it("can narrow scope for one access token but never widen it", async () => {
      const { auth, tokens } = await tokensFor({ scope: "openid email offline_access" });
      const widened = await refresh(auth, tokens.refresh_token, { scope: "openid profile" });
      expect(widened.json().error).toBe("invalid_scope");

      // The rejected request didn't spend the token.
      const narrowed = await refresh(auth, tokens.refresh_token, { scope: "openid" });
      expect(narrowed.statusCode).toBe(200);
      const body = narrowed.json();
      expect(body.scope).toBe("openid");
      expect(Object.keys((await userinfo(body.access_token)).json())).toEqual(["sub"]);
      // The refresh token keeps the full grant.
      expect((await introspect(auth, body.refresh_token)).scope).toBe("openid email offline_access");
    });

    it("expire after the idle TTL and at the family's absolute lifetime", async () => {
      const idle = await tokensFor();
      await t.ctx.db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.grantId, decodeJwt(idle.tokens.access_token).gid as string));
      expect((await refresh(idle.auth, idle.tokens.refresh_token)).json().error).toBe("invalid_grant");

      const absolute = await tokensFor();
      await t.ctx.db
        .update(grants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(grants.id, decodeJwt(absolute.tokens.access_token).gid as string));
      expect((await refresh(absolute.auth, absolute.tokens.refresh_token)).json().error).toBe("invalid_grant");
    });

    it("work for public clients, with no secret", async () => {
      const { client } = await registerClient(t.ctx, { type: "public" });
      const flow = await signUpAndAuthorize(t.app, client, { extra: OFFLINE });
      const tokens = (
        await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, client_id: client.id })
      ).json();
      const res = await clientPost(t.app, "/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.id });
      expect(res.statusCode).toBe(200);
    });

    it("reject garbage", async () => {
      const { auth } = await tokensFor();
      expect((await refresh(auth, "krt_nope")).json().error).toBe("invalid_grant");
      expect((await clientPost(t.app, "/token", { grant_type: "refresh_token" }, auth)).json().error).toBe("invalid_request");
    });
  });

  describe("authorization code replay", () => {
    it("revokes the tokens issued from the first redemption", async () => {
      const { client, secret } = await registerClient(t.ctx);
      const auth = { id: client.id, secret: secret! };
      const flow = await signUpAndAuthorize(t.app, client, { extra: OFFLINE });
      const params = { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier };
      const first = (await redeem(t.app, params, auth)).json();
      expect((await userinfo(first.access_token)).statusCode).toBe(200);

      const second = await redeem(t.app, params, auth);
      expect(second.json().error).toBe("invalid_grant");
      expect((await userinfo(first.access_token)).statusCode).toBe(401);
      expect((await refresh(auth, first.refresh_token)).json().error).toBe("invalid_grant");
    });
  });

  describe("revocation (RFC 7009)", () => {
    it("revoking a refresh token revokes its family and access tokens", async () => {
      const { auth, tokens } = await tokensFor();
      const res = await clientPost(t.app, "/revoke", { token: tokens.refresh_token, token_type_hint: "refresh_token" }, auth);
      expect(res.statusCode).toBe(200);
      expect((await refresh(auth, tokens.refresh_token)).json().error).toBe("invalid_grant");
      expect((await userinfo(tokens.access_token)).statusCode).toBe(401);
    });

    it("revoking an access token kills only that token", async () => {
      const { auth, tokens } = await tokensFor();
      // Wrong hint is fine: hints are only hints.
      expect((await clientPost(t.app, "/revoke", { token: tokens.access_token, token_type_hint: "refresh_token" }, auth)).statusCode).toBe(200);
      expect((await userinfo(tokens.access_token)).statusCode).toBe(401);
      expect(await introspect(auth, tokens.access_token)).toEqual({ active: false });
      // The refresh token, and what it mints, still work.
      const next = (await refresh(auth, tokens.refresh_token)).json();
      expect((await userinfo(next.access_token)).statusCode).toBe(200);
    });

    it("answers 200 for unknown and foreign tokens without acting on them", async () => {
      const { auth, tokens } = await tokensFor();
      const other = await registerClient(t.ctx);
      const otherAuth = { id: other.client.id, secret: other.secret! };
      expect((await clientPost(t.app, "/revoke", { token: "nonsense" }, otherAuth)).statusCode).toBe(200);
      expect((await clientPost(t.app, "/revoke", { token: tokens.refresh_token }, otherAuth)).statusCode).toBe(200);
      expect((await clientPost(t.app, "/revoke", { token: tokens.access_token }, otherAuth)).statusCode).toBe(200);
      expect((await introspect(auth, tokens.refresh_token)).active).toBe(true);
      expect((await userinfo(tokens.access_token)).statusCode).toBe(200);
    });

    it("requires client authentication and a token", async () => {
      const { auth, tokens } = await tokensFor();
      expect((await clientPost(t.app, "/revoke", { token: tokens.refresh_token })).statusCode).toBe(401);
      expect((await clientPost(t.app, "/revoke", {}, auth)).json().error).toBe("invalid_request");
    });
  });

  describe("introspection (RFC 7662)", () => {
    it("describes an active access token", async () => {
      const { auth, client, tokens } = await tokensFor();
      const body = await introspect(auth, tokens.access_token);
      expect(body).toMatchObject({
        active: true,
        token_type: "Bearer",
        client_id: client.id,
        scope: "openid profile email offline_access",
        sub: decodeJwt(tokens.id_token).sub,
      });
      expect(body.exp).toBeGreaterThan(Date.now() / 1000);
    });

    it("describes an active refresh token, and reports a spent one inactive", async () => {
      const { auth, tokens } = await tokensFor();
      expect(await introspect(auth, tokens.refresh_token)).toMatchObject({ active: true, token_type: "refresh_token" });
      await refresh(auth, tokens.refresh_token);
      expect(await introspect(auth, tokens.refresh_token)).toEqual({ active: false });
    });

    it("reports other clients' tokens and garbage as inactive", async () => {
      const { tokens } = await tokensFor();
      const other = await registerClient(t.ctx);
      const otherAuth = { id: other.client.id, secret: other.secret! };
      expect(await introspect(otherAuth, tokens.access_token)).toEqual({ active: false });
      expect(await introspect(otherAuth, tokens.refresh_token)).toEqual({ active: false });
      expect(await introspect(otherAuth, "garbage")).toEqual({ active: false });
    });

    it("refuses public and unauthenticated clients", async () => {
      const { tokens } = await tokensFor();
      expect((await clientPost(t.app, "/introspect", { token: tokens.access_token })).statusCode).toBe(401);
      const pub = await registerClient(t.ctx, { type: "public" });
      const res = await clientPost(t.app, "/introspect", { token: tokens.access_token, client_id: pub.client.id });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("first-party apps", () => {
    it("share one subject across Kingdom apps, while third-party apps stay pairwise", async () => {
      const cappuccino = await registerClient(t.ctx, { firstParty: true });
      const inkspirit = await registerClient(t.ctx, { firstParty: true });
      const thirdParty = await registerClient(t.ctx);

      const flow = await signUpAndAuthorize(t.app, cappuccino.client);
      const sub = async (c: Awaited<ReturnType<typeof registerClient>>, code: string, verifier: string) =>
        decodeJwt(
          (await redeem(t.app, { code, redirect_uri: c.client.redirectUris[0]!, code_verifier: verifier }, { id: c.client.id, secret: c.secret! })).json()
            .id_token,
        ).sub;
      const subA = await sub(cappuccino, flow.code, flow.verifier);

      const authorizeWith = async (c: Awaited<ReturnType<typeof registerClient>>) => {
        const p = pkce();
        const start = await flow.browser.get(
          authorizeUrl({ client_id: c.client.id, redirect_uri: c.client.redirectUris[0]!, code_challenge: p.challenge, code_challenge_method: "S256" }),
        );
        const interaction = location(start).pathname;
        const consent = await flow.browser.submit(interaction, `${interaction}/consent`, { decision: "allow" });
        return sub(c, location(consent).searchParams.get("code")!, p.verifier);
      };

      expect(await authorizeWith(inkspirit)).toBe(subA);
      expect(await authorizeWith(thirdParty)).not.toBe(subA);
    });
  });
});
