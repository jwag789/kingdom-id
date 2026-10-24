import type { Client } from "@kingdom-id/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { sha256 } from "../lib/crypto.js";
import { OAuthError } from "../lib/errors.js";
import { verifyPkce } from "../oauth/pkce.js";
import { limits } from "../security/rate-limit.js";

type Body = Record<string, string | undefined>;

/**
 * Shared front half of every client-authenticated endpoint (token,
 * revocation, introspection): form encoding, rate limits, single-valued
 * parameters, then client authentication.
 */
export async function authenticateClientRequest(ctx: Context, req: FastifyRequest): Promise<{ client: Client; body: Body }> {
  if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    throw new OAuthError("invalid_request", "body must be application/x-www-form-urlencoded");
  }
  await ctx.rateLimiter.consume(limits.tokenByIp(req.ip));
  const raw = (req.body ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) throw new OAuthError("invalid_request", `parameter repeated: ${name}`);
  }
  const client = await ctx.clients.authenticate(req);
  // Per-client limit after authentication, so nobody can exhaust another client's budget.
  await ctx.rateLimiter.consume(limits.tokenByClient(client.id));
  return { client, body: raw as Body };
}

export function registerTokenRoutes(app: FastifyInstance, ctx: Context) {
  app.post("/token", async (req, reply) => {
    reply.header("cache-control", "no-store").header("pragma", "no-cache");
    const { client, body } = await authenticateClientRequest(ctx, req);
    switch (body.grant_type) {
      case "authorization_code":
        return authorizationCode(ctx, req, client, body);
      case "refresh_token":
        return refreshToken(ctx, req, client, body);
      case undefined:
        throw new OAuthError("invalid_request", "grant_type is required");
      default:
        throw new OAuthError("unsupported_grant_type", "supported: authorization_code, refresh_token");
    }
  });
}

async function authorizationCode(ctx: Context, req: FastifyRequest, client: Client, body: Body) {
  const code = body.code;
  if (!code) throw new OAuthError("invalid_request", "code is required");
  const invalidGrant = new OAuthError("invalid_grant", "authorization code is invalid, expired, or already used");

  const codeHash = sha256(code);
  const redemption = await ctx.codes.redeem(code);
  if (redemption.status === "replayed") {
    // A second redemption means the code leaked, and the first redemption may
    // have been the attacker's. Revoke everything it produced (RFC 6749 §4.1.2).
    const revoked = await ctx.grants.revokeByCodeHash(codeHash);
    req.log.warn({ event: "code_replay", clientId: redemption.clientId, grantId: revoked?.id }, "authorization code replay");
    throw invalidGrant;
  }
  if (redemption.status === "invalid") throw invalidGrant;
  const { grant: issued } = redemption;

  // The code is already spent at this point, so any mismatch below burns it
  // for the legitimate client too. That's intended: it fails closed.
  if (issued.clientId !== client.id) throw invalidGrant;
  if (body.redirect_uri !== issued.redirectUri) throw invalidGrant;
  if (!verifyPkce(body.code_verifier, issued.codeChallenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed");
  }

  const user = await ctx.users.findById(issued.userId);
  if (!user) throw invalidGrant;
  const grant = await ctx.grants.create(issued, codeHash);
  const refresh = grant.offline ? await ctx.grants.issueRefreshToken(grant) : undefined;
  return ctx.tokens.issue(client, user, grant, {
    scopes: grant.scopes,
    ...(issued.nonce !== undefined ? { nonce: issued.nonce } : {}),
    ...(refresh ? { refreshToken: refresh } : {}),
  });
}

async function refreshToken(ctx: Context, req: FastifyRequest, client: Client, body: Body) {
  if (!body.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
  const invalidGrant = new OAuthError("invalid_grant", "refresh token is invalid, expired, or revoked");

  // Validate the scope before rotating, so a bad request doesn't spend the token.
  const found = await ctx.grants.lookup(body.refresh_token);
  const requested = body.scope?.split(" ").filter(Boolean);
  if (found && requested && !requested.every((s) => found.grant.scopes.includes(s))) {
    throw new OAuthError("invalid_scope", "requested scope exceeds the original grant");
  }

  const rotation = await ctx.grants.rotate(body.refresh_token, client.id);
  if (rotation.status === "reused") {
    req.log.warn(
      { event: "refresh_token_reuse", clientId: client.id, grantId: rotation.grant.id, userId: rotation.grant.userId },
      "refresh token reuse: family revoked",
    );
    throw invalidGrant;
  }
  if (rotation.status === "invalid") throw invalidGrant;

  const user = await ctx.users.findById(rotation.grant.userId);
  if (!user) throw invalidGrant;
  // The new refresh token keeps the grant's full scope (RFC 6749 §6); only
  // this access token is narrowed.
  const scopes = requested ? rotation.grant.scopes.filter((s) => requested.includes(s)) : rotation.grant.scopes;
  return ctx.tokens.issue(client, user, rotation.grant, { scopes, refreshToken: rotation.refreshToken });
}
