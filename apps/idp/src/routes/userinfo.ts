import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { userClaims } from "../oauth/scopes.js";
import { limits } from "../security/rate-limit.js";

export function registerUserinfoRoutes(app: FastifyInstance, ctx: Context) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    await ctx.rateLimiter.consume(limits.userinfo(req.ip));

    const unauthorized = (error?: "invalid_token" | "invalid_request", description?: string) => {
      const params = ['realm="kingdom-id"'];
      if (error) params.push(`error="${error}"`);
      if (description) params.push(`error_description="${description}"`);
      return reply
        .status(error === "invalid_request" ? 400 : 401)
        .header("www-authenticate", `Bearer ${params.join(", ")}`)
        .send(error ? { error, ...(description ? { error_description: description } : {}) } : undefined);
    };

    // RFC 6750: header (§2.1) or form body (§2.2), never both.
    const header = req.headers.authorization;
    const fromHeader = header?.match(/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i)?.[1];
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fromBody = typeof body.access_token === "string" ? body.access_token : undefined;
    if (fromHeader && fromBody) return unauthorized("invalid_request", "token sent more than once");
    const token = fromHeader ?? fromBody;
    if (!token) return unauthorized();

    const verified = await ctx.accessTokens.verify(token);
    if (!verified) return unauthorized("invalid_token", "access token is invalid, expired, or revoked");
    const { claims } = verified;

    // The consent row maps the client-specific sub back to the user, and its
    // absence means the user disconnected the app: the token stops working.
    const user = await ctx.consents.userForSubject(claims.client_id, claims.sub);
    if (!user) return unauthorized("invalid_token", "access token is no longer valid");

    const scopes = claims.scope.split(" ");
    if (!scopes.includes("openid")) return unauthorized("invalid_token", "token lacks the openid scope");
    return reply.send({
      sub: claims.sub,
      ...userClaims(user, scopes),
      ...(scopes.includes("perks") ? { perks: await ctx.perks.claimFor(user.id) } : {}),
    });
  };

  app.get("/userinfo", handler);
  app.post("/userinfo", handler);
}
