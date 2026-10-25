import { z } from "zod";

const duration = z.coerce.number().int().positive();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  // The issuer identifier. Must be the exact externally visible origin (plus
  // optional path); every token and the discovery document derive from it.
  ISSUER: z.url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // 32 random bytes, base64. Encrypts signing keys at rest.
  KEY_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  // 32+ random bytes, base64. HMAC key for CSRF tokens and pairwise subjects.
  SERVER_SECRET: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length >= 32, "must be at least 32 bytes, base64-encoded"),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Scales every rate limit. 1 in production; the conformance environment
  // raises it because one test IP signs one user in dozens of times a minute.
  RATE_LIMIT_MULTIPLIER: z.coerce.number().positive().default(1),
  // Per-app private email addresses (phase 6). Until they exist, no page claims them.
  EMAIL_RELAY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  ACCESS_TOKEN_TTL_SECONDS: duration.default(600),
  ID_TOKEN_TTL_SECONDS: duration.default(600),
  AUTH_CODE_TTL_SECONDS: duration.default(60),
  INTERACTION_TTL_SECONDS: duration.default(900),
  SESSION_TTL_SECONDS: duration.default(60 * 60 * 24 * 14),
  // A refresh token unused for the idle TTL expires; no rotation chain lives
  // past the absolute TTL, after which the user must sign in again.
  REFRESH_TOKEN_IDLE_TTL_SECONDS: duration.default(60 * 60 * 24 * 30),
  REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS: duration.default(60 * 60 * 24 * 90),
  // How long a key stays active before rotation, and how long a retired key
  // stays in the JWKS so tokens it signed can still be verified.
  KEY_ROTATION_INTERVAL_SECONDS: duration.default(60 * 60 * 24 * 30),
  KEY_RETIREMENT_GRACE_SECONDS: duration.default(60 * 60 * 24),
});

export type Config = z.infer<typeof schema> & { secureCookies: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const config = parsed.data;
  const issuer = new URL(config.ISSUER);
  if (issuer.search || issuer.hash) throw new Error("ISSUER must not contain a query or fragment");
  if (config.NODE_ENV === "production" && issuer.protocol !== "https:") {
    throw new Error("ISSUER must use https in production");
  }
  // Strip a trailing slash so `${issuer}/token` never doubles it.
  config.ISSUER = config.ISSUER.replace(/\/+$/, "");
  // `Secure` cookies work on http://localhost in every current browser, so
  // only a plain-http non-localhost issuer (never allowed in production) opts out.
  const secureCookies = issuer.protocol === "https:" || issuer.hostname === "localhost";
  return { ...config, secureCookies };
}
