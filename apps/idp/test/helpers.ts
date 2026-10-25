import { randomBytes, randomUUID } from "node:crypto";
import { connect, runMigrations } from "@kingdom-id/db";
import postgres from "postgres";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { inject } from "vitest";
import { type AppDeps, buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Context } from "../src/context.js";
import { connectRedis } from "../src/lib/redis.js";
import { sha256 } from "../src/lib/crypto.js";
import type { CreateClientInput } from "../src/oauth/clients.js";

export const ISSUER = "http://localhost:4000";

// Fixed across test apps because they share the signing_keys table.
const TEST_KEK = Buffer.alloc(32, 7).toString("base64");
const TEST_SECRET = Buffer.alloc(32, 9).toString("base64");

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    ISSUER,
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    KEY_ENCRYPTION_KEY: TEST_KEK,
    SERVER_SECRET: TEST_SECRET,
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

export interface TestApp {
  app: FastifyInstance;
  ctx: Context;
  close: () => Promise<void>;
}

/** Builds the real app against the shared containers. */
export async function createTestApp(
  overrides: Record<string, string> = {},
  deps: Pick<AppDeps, "relayTransport" | "relayInbound"> = {},
): Promise<TestApp> {
  const config = testConfig(overrides);
  const database = connect(config.DATABASE_URL, { max: 4 });
  const redis = connectRedis(config.REDIS_URL);
  const { app, ctx } = await buildApp({ config, db: database.db, redis, logger: false, ...deps });
  await ctx.keys.ensureKeys();
  await app.ready();
  return {
    app,
    ctx,
    close: async () => {
      await app.close();
      await Promise.all([database.close(), redis.quit()]);
    },
  };
}

export async function registerClient(ctx: Context, input: Partial<CreateClientInput> = {}) {
  const host = `${randomUUID().slice(0, 8)}.example.test`;
  return ctx.clients.create({
    name: "Test App",
    type: "confidential",
    redirectUris: [`https://${host}/callback`],
    ...input,
  });
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: sha256(verifier) };
}

export const uniqueEmail = () => `user-${randomUUID()}@example.test`;
export const PASSWORD = "correct horse battery staple";

/**
 * A browser: a cookie jar and a distinct client IP over app.inject. Each
 * test browser gets its own IP so per-IP rate limits don't couple tests.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly ip = `10.${rand()}.${rand()}.${rand()}`;

  constructor(private readonly app: FastifyInstance) {}

  get(url: string, headers: Record<string, string> = {}) {
    return this.send("GET", url, undefined, headers);
  }

  post(url: string, form: Record<string, string>, headers: Record<string, string> = {}) {
    return this.send("POST", url, new URLSearchParams(form).toString(), {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    });
  }

  /** A JSON POST, as passkey.js sends: the CSRF token travels in the body. */
  json(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return this.send("POST", url, JSON.stringify(body), { "content-type": "application/json", ...headers });
  }

  /** The CSRF token for this browser, read from any page that renders one. */
  async csrf(pageUrl = "/login") {
    return csrfFrom((await this.get(pageUrl)).body);
  }

  /** Posts a form found on the page at `pageUrl`, carrying its CSRF token. */
  async submit(pageUrl: string, action: string, fields: Record<string, string>) {
    const page = await this.get(pageUrl);
    return this.post(action, { csrf: csrfFrom(page.body), ...fields });
  }

  private async send(method: "GET" | "POST", url: string, payload: string | undefined, headers: Record<string, string>) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await this.app.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      ...(payload !== undefined ? { payload } : {}),
    });
    for (const c of res.cookies as { name: string; value: string; maxAge?: number }[]) {
      if (c.value === "" || c.maxAge === 0) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }
}

const rand = () => Math.floor(Math.random() * 254) + 1;

export function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match) throw new Error("no CSRF token on page");
  return match[1]!;
}

export function location(res: LightMyRequestResponse): URL {
  const loc = res.headers.location;
  if (typeof loc !== "string") throw new Error(`expected a redirect, got ${res.statusCode}: ${res.body.slice(0, 200)}`);
  return new URL(loc, ISSUER);
}

export function authorizeUrl(params: Record<string, string>) {
  return `/authorize?${new URLSearchParams({ response_type: "code", scope: "openid profile email", ...params })}`;
}

/**
 * Drives a fresh user through signup and consent. Returns the authorization
 * code redirect and everything needed to redeem it.
 */
export async function signUpAndAuthorize(
  app: FastifyInstance,
  client: { id: string; redirectUris: string[] },
  options: { browser?: Browser; email?: string; extra?: Record<string, string> } = {},
) {
  const browser = options.browser ?? new Browser(app);
  const email = options.email ?? uniqueEmail();
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString("hex");
  const nonce = randomBytes(8).toString("hex");
  const redirectUri = client.redirectUris[0]!;

  const start = await browser.get(
    authorizeUrl({
      client_id: client.id,
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...options.extra,
    }),
  );
  const interaction = location(start).pathname;
  const signup = await browser.submit(`${interaction}/signup`, `${interaction}/signup`, {
    name: "Ada Lovelace",
    email,
    password: PASSWORD,
  });
  if (signup.statusCode !== 303) throw new Error(`signup failed: ${signup.statusCode}`);
  const consent = await browser.submit(interaction, `${interaction}/consent`, { decision: "allow" });
  const callback = location(consent);
  return { browser, email, verifier, state, nonce, redirectUri, callback, code: callback.searchParams.get("code")! };
}

export function basicAuth(id: string, secret: string) {
  const enc = (s: string) => encodeURIComponent(s);
  return `Basic ${Buffer.from(`${enc(id)}:${enc(secret)}`).toString("base64")}`;
}

export async function redeem(
  app: FastifyInstance,
  params: Record<string, string>,
  auth?: { id: string; secret: string },
) {
  return clientPost(app, "/token", { grant_type: "authorization_code", ...params }, auth);
}

/** A client-authenticated form POST to /token, /revoke or /introspect. */
export async function clientPost(
  app: FastifyInstance,
  url: string,
  params: Record<string, string>,
  auth?: { id: string; secret: string },
) {
  return app.inject({
    method: "POST",
    url,
    remoteAddress: `10.200.${rand()}.${rand()}`,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(auth ? { authorization: basicAuth(auth.id, auth.secret) } : {}),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

/** A brand-new migrated database, for tests that need exclusive tables (key rotation). */
export async function freshDatabaseUrl(): Promise<string> {
  const base = inject("databaseUrl");
  const name = `t_${randomUUID().replace(/-/g, "")}`;
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return url.toString();
}
