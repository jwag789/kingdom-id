import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import { assetsDir, tokensCssPath } from "@kingdom-id/brand";
import type { Database } from "@kingdom-id/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { EmailVerification, LogMailer, type Mailer } from "./accounts/email-verification.js";
import { PasskeyService } from "./accounts/passkeys.js";
import { SessionService } from "./accounts/sessions.js";
import { UserService } from "./accounts/users.js";
import type { Config } from "./config.js";
import type { Context } from "./context.js";
import { KeyStore } from "./keys/keystore.js";
import { OAuthError } from "./lib/errors.js";
import { ClientService } from "./oauth/clients.js";
import { AccessTokenVerifier } from "./oauth/access-tokens.js";
import { CodeStore } from "./oauth/codes.js";
import { ConsentService } from "./oauth/consents.js";
import { GrantService } from "./oauth/grants.js";
import { InteractionStore } from "./oauth/interactions.js";
import { TokenService } from "./oauth/tokens.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerAuthorizeRoutes } from "./routes/authorize.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInteractionRoutes } from "./routes/interaction.js";
import { registerLogoutRoutes } from "./routes/logout.js";
import { registerPasskeyRoutes } from "./routes/passkeys.js";
import { registerTokenManagementRoutes } from "./routes/token-management.js";
import { registerTokenRoutes } from "./routes/token.js";
import { registerUserinfoRoutes } from "./routes/userinfo.js";
import { cookieName } from "./security/cookies.js";
import { Csrf, CsrfError } from "./security/csrf.js";
import { registerSecurityHeaders } from "./security/headers.js";
import { RateLimitedError, RateLimiter } from "./security/rate-limit.js";
import { sendPage, uiFor } from "./views/layout.js";
import { MessagePage } from "./views/pages.js";

export interface AppDeps {
  config: Config;
  db: Database;
  redis: Redis;
  mailer?: Mailer;
  logger?: FastifyServerOptions["logger"];
}

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const fontDir = (pkg: string) => join(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)), "files");

// Endpoints called by client software rather than browsers get JSON errors.
const JSON_ROUTES = ["/token", "/userinfo", "/revoke", "/introspect", "/passkeys/"];

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: Context }> {
  const { config, db, redis } = deps;
  const app = Fastify({
    // Credentials never reach the logs.
    logger: deps.logger ?? { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 64 * 1024,
  });

  const serverSecret = Buffer.from(config.SERVER_SECRET, "base64");
  const keys = new KeyStore(db, Buffer.from(config.KEY_ENCRYPTION_KEY, "base64"), {
    rotationIntervalSeconds: config.KEY_ROTATION_INTERVAL_SECONDS,
    retirementGraceSeconds: config.KEY_RETIREMENT_GRACE_SECONDS,
  });
  const grants = new GrantService(db, {
    accessTokenTtl: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshIdleTtl: config.REFRESH_TOKEN_IDLE_TTL_SECONDS,
    refreshAbsoluteTtl: config.REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS,
  });
  const mailer = deps.mailer ?? new LogMailer((msg, data) => app.log.info(data, msg));

  const ctx: Context = {
    config,
    db,
    redis,
    serverSecret,
    keys,
    users: new UserService(db),
    sessions: new SessionService(db, config.SESSION_TTL_SECONDS),
    // The issuer's host is the WebAuthn relying party ID: passkeys are bound to it.
    passkeys: new PasskeyService(db, redis, { rpID: new URL(config.ISSUER).hostname, origin: new URL(config.ISSUER).origin }),
    sessionCookie: cookieName("kid_session", config.secureCookies),
    emailVerification: new EmailVerification(redis, mailer, config.ISSUER),
    clients: new ClientService(db),
    consents: new ConsentService(db),
    codes: new CodeStore(redis, config.AUTH_CODE_TTL_SECONDS),
    interactions: new InteractionStore(redis, config.INTERACTION_TTL_SECONDS),
    grants,
    accessTokens: new AccessTokenVerifier(keys, grants, redis, config.ISSUER),
    tokens: new TokenService(keys, {
      issuer: config.ISSUER,
      serverSecret,
      accessTokenTtl: config.ACCESS_TOKEN_TTL_SECONDS,
      idTokenTtl: config.ID_TOKEN_TTL_SECONDS,
    }),
    csrf: new Csrf(serverSecret, config.secureCookies),
    rateLimiter: new RateLimiter(redis, config.RATE_LIMIT_MULTIPLIER),
  };

  await app.register(cookie);
  await app.register(formbody);
  registerSecurityHeaders(app, { hsts: config.NODE_ENV === "production" });

  await app.register(fastifyStatic, { root: publicDir, prefix: "/assets/", maxAge: "1h" });
  await app.register(fastifyStatic, {
    root: [assetsDir, dirname(tokensCssPath)],
    prefix: "/brand/",
    maxAge: "1d",
    decorateReply: false,
  });

  // Self-hosted fonts: no third-party requests from the sign-in page.
  await app.register(fastifyStatic, {
    root: [fontDir("@fontsource-variable/inter"), fontDir("@fontsource-variable/newsreader")],
    prefix: "/fonts/",
    maxAge: "30d",
    immutable: true,
    decorateReply: false,
  });

  app.setErrorHandler(async (err, req, reply) => {
    const wantsJson = JSON_ROUTES.some((r) => req.url.startsWith(r));
    if (err instanceof RateLimitedError) {
      reply.status(429).header("retry-after", String(err.retryAfterSeconds));
      return wantsJson
        ? reply.header("cache-control", "no-store").send({ error: "rate_limited", error_description: "too many requests" })
        : sendPage(reply, MessagePage({ ui: uiFor(ctx, req), title: "Slow down", message: "Too many attempts. Wait a moment and try again.", tone: "error" }), 429);
    }
    if (err instanceof CsrfError) {
      if (wantsJson) return reply.status(403).send({ error: "Your page expired. Reload and try again." });
      return sendPage(
        reply,
        MessagePage({ ui: uiFor(ctx, req), title: "Your form expired", message: "Go back, reload the page, and try again.", tone: "error" }),
        403,
      );
    }
    if (err instanceof OAuthError) {
      if (err.status === 401 && req.headers.authorization?.toLowerCase().startsWith("basic ")) {
        reply.header("www-authenticate", 'Basic realm="kingdom-id"');
      }
      return reply.status(err.status).header("cache-control", "no-store").send(err.toJSON());
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    if (wantsJson) {
      return reply.status(status).send({ error: status >= 500 ? "server_error" : "invalid_request" });
    }
    return sendPage(
      reply,
      MessagePage({ ui: uiFor(ctx, req), title: "Something went wrong", message: "Kingdom ID couldn't complete that request.", tone: "error" }),
      status,
    );
  });

  registerHealthRoutes(app, ctx);
  registerDiscoveryRoutes(app, ctx);
  registerAuthorizeRoutes(app, ctx);
  registerInteractionRoutes(app, ctx);
  registerTokenRoutes(app, ctx);
  registerUserinfoRoutes(app, ctx);
  registerTokenManagementRoutes(app, ctx);
  registerLogoutRoutes(app, ctx);
  registerPasskeyRoutes(app, ctx);
  registerAccountRoutes(app, ctx);

  return { app, ctx };
}
