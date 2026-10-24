import type { FastifyInstance } from "fastify";
import { randomToken } from "../lib/crypto.js";

declare module "fastify" {
  interface FastifyRequest {
    cspNonce: string;
    /** Extra `form-action` sources (see onSend below). */
    formActionSources: string[];
  }
}

export function registerSecurityHeaders(app: FastifyInstance, opts: { hsts: boolean }): void {
  app.decorateRequest("cspNonce", "");
  app.decorateRequest("formActionSources", null as unknown as string[]);
  app.addHook("onRequest", async (req) => {
    req.cspNonce = randomToken(16);
    req.formActionSources = [];
  });

  app.addHook("onSend", async (req, reply) => {
    // Chrome applies form-action to the redirect that follows a form POST,
    // so pages whose forms end in a redirect to a relying party must list
    // that origin, or the consent submit would be blocked.
    const formAction = ["'self'", ...new Set(req.formActionSources)].join(" ");
    reply.header(
      "content-security-policy",
      [
        "default-src 'none'",
        `script-src 'nonce-${req.cspNonce}' 'strict-dynamic'`,
        "style-src 'self'",
        "img-src 'self' https: data:",
        "font-src 'self'",
        "connect-src 'self'",
        `form-action ${formAction}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    // Authorization responses put the code in the URL; never leak it via Referer.
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    if (opts.hsts) reply.header("strict-transport-security", "max-age=63072000; includeSubDomains");
  });
}
