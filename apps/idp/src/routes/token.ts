import type { FastifyInstance } from "fastify";
import type { Context } from "../context.js";
import { OAuthError } from "../lib/errors.js";
import { verifyPkce } from "../oauth/pkce.js";
import { limits } from "../security/rate-limit.js";

export function registerTokenRoutes(app: FastifyInstance, ctx: Context) {
  app.post("/token", async (req, reply) => {
    reply.header("cache-control", "no-store").header("pragma", "no-cache");
    if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
      throw new OAuthError("invalid_request", "body must be application/x-www-form-urlencoded");
    }
    const body = req.body as Record<string, unknown>;
    await ctx.rateLimiter.consume(limits.tokenByIp(req.ip));

    for (const [name, value] of Object.entries(body)) {
      if (Array.isArray(value)) throw new OAuthError("invalid_request", `parameter repeated: ${name}`);
    }
    const client = await ctx.clients.authenticate(req);
    // Per-client limit after authentication, so nobody can exhaust another client's budget.
    await ctx.rateLimiter.consume(limits.tokenByClient(client.id));

    const grantType = body.grant_type;
    if (typeof grantType !== "string") throw new OAuthError("invalid_request", "grant_type is required");
    if (grantType !== "authorization_code") {
      throw new OAuthError("unsupported_grant_type", "only authorization_code is supported");
    }

    const code = body.code;
    if (typeof code !== "string" || !code) throw new OAuthError("invalid_request", "code is required");
    const invalidGrant = new OAuthError("invalid_grant", "authorization code is invalid, expired, or already used");

    const redemption = await ctx.codes.redeem(code);
    if (redemption.status === "replayed") {
      // A replayed code means the first redemption may have been an attacker's.
      // Phase 2 revokes the tokens issued from it; for now, log it loudly.
      req.log.warn({ clientId: redemption.clientId, event: "code_replay" }, "authorization code replay");
      throw invalidGrant;
    }
    if (redemption.status === "invalid") throw invalidGrant;
    const { grant } = redemption;

    // The code is already spent at this point, so any mismatch below burns it
    // for the legitimate client too. That's intended: it fails closed.
    if (grant.clientId !== client.id) throw invalidGrant;
    if (body.redirect_uri !== grant.redirectUri) throw invalidGrant;
    if (!verifyPkce(typeof body.code_verifier === "string" ? body.code_verifier : undefined, grant.codeChallenge)) {
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    }

    const user = await ctx.users.findById(grant.userId);
    if (!user) throw invalidGrant;
    return ctx.tokens.issue(client, user, grant);
  });
}
