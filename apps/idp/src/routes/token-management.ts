import type { FastifyInstance } from "fastify";
import type { Context } from "../context.js";
import { OAuthError } from "../lib/errors.js";
import { isRefreshTokenShaped } from "../oauth/grants.js";
import { authenticateClientRequest } from "./token.js";

/** Token revocation (RFC 7009) and introspection (RFC 7662). */
export function registerTokenManagementRoutes(app: FastifyInstance, ctx: Context) {
  app.post("/revoke", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { client, body } = await authenticateClientRequest(ctx, req);
    const token = body.token;
    if (!token) throw new OAuthError("invalid_request", "token is required");

    // token_type_hint is only a hint (§2.1); the token's shape decides.
    if (isRefreshTokenShaped(token)) {
      const found = await ctx.grants.lookup(token);
      // Revoking a refresh token revokes its grant: the whole family and the
      // access tokens minted from it (§2.1 permits, and it's what users expect).
      if (found && found.grant.clientId === client.id) {
        await ctx.grants.revoke(found.grant.id, "revoked_by_client");
        req.log.info({ event: "token_revoked", clientId: client.id, grantId: found.grant.id }, "grant revoked by client");
      }
    } else {
      const verified = await ctx.accessTokens.verify(token);
      if (verified && verified.claims.client_id === client.id) await ctx.accessTokens.revoke(verified.claims);
    }
    // Unknown, already-invalid, or another client's token: still 200 (§2.2),
    // so the endpoint can't be used to probe which tokens are valid.
    return reply.status(200).send();
  });

  app.post("/introspect", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { client, body } = await authenticateClientRequest(ctx, req);
    // Introspection reveals token metadata, so it requires a client that can
    // actually authenticate (RFC 7662 §2.1); public clients can't.
    if (client.tokenEndpointAuthMethod === "none") {
      throw new OAuthError("invalid_client", "public clients cannot introspect", 401);
    }
    const token = body.token;
    if (!token) throw new OAuthError("invalid_request", "token is required");
    const inactive = { active: false };

    if (isRefreshTokenShaped(token)) {
      const found = await ctx.grants.lookup(token);
      if (!found || found.grant.clientId !== client.id) return inactive;
      const { refreshToken, grant } = found;
      if (refreshToken.usedAt || refreshToken.expiresAt <= new Date() || !ctx.grants.isActive(grant)) return inactive;
      return {
        active: true,
        token_type: "refresh_token",
        scope: grant.scopes.join(" "),
        client_id: grant.clientId,
        sub: grant.subject,
        iss: ctx.config.ISSUER,
        iat: seconds(refreshToken.createdAt),
        exp: seconds(refreshToken.expiresAt),
      };
    }

    const verified = await ctx.accessTokens.verify(token);
    // A client may introspect only tokens issued to it; others are simply inactive.
    if (!verified || verified.claims.client_id !== client.id) return inactive;
    const { claims } = verified;
    return {
      active: true,
      token_type: "Bearer",
      scope: claims.scope,
      client_id: claims.client_id,
      sub: claims.sub,
      iss: claims.iss,
      aud: claims.aud,
      jti: claims.jti,
      iat: claims.iat,
      exp: claims.exp,
      auth_time: claims.auth_time,
    };
  });
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
