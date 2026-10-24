import type { FastifyInstance, FastifyReply } from "fastify";
import type { Context } from "../context.js";
import { CLAIMS_SUPPORTED, SUPPORTED_SCOPES } from "../oauth/scopes.js";

export function discoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public", "pairwise"],
    id_token_signing_alg_values_supported: ["RS256", "ES256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: CLAIMS_SUPPORTED,
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    prompt_values_supported: ["none", "login", "consent", "select_account", "create"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://github.com/jwag789/kingdom-id",
  };
}

export function registerDiscoveryRoutes(app: FastifyInstance, ctx: Context) {
  const doc = discoveryDocument(ctx.config.ISSUER);
  // Public, cacheable metadata; CORS-open so browser-based clients can read it.
  const send = async (_req: unknown, reply: FastifyReply) =>
    reply.header("cache-control", "public, max-age=3600").header("access-control-allow-origin", "*").send(doc);
  app.get("/.well-known/openid-configuration", send);
  // RFC 8414 metadata location; same document.
  app.get("/.well-known/oauth-authorization-server", send);

  app.get("/.well-known/jwks.json", async (_req, reply) =>
    reply
      // Short enough that a rotation propagates quickly, long enough to absorb load.
      .header("cache-control", "public, max-age=300")
      .header("access-control-allow-origin", "*")
      .type("application/jwk-set+json")
      .send(await ctx.keys.jwks()),
  );
}
