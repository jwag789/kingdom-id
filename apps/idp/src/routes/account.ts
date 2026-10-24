import type { User } from "@kingdom-id/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EmailTakenError, signupSchema } from "../accounts/users.js";
import type { Context } from "../context.js";
import { cookieOptions } from "../security/cookies.js";
import { limits } from "../security/rate-limit.js";
import { signOut } from "./logout.js";
import { sendPage } from "../views/layout.js";
import { AccountPage, LoginPage, MessagePage, SignupPage } from "../views/pages.js";

const GENERIC_LOGIN_ERROR = "That email and password don't match a Kingdom account.";

type LoginResult = { ok: true; user: User } | { ok: false; email: string; error: string };

/** Validates a login form. Shared by the standalone and interaction flows. */
export async function attemptLogin(ctx: Context, req: FastifyRequest): Promise<LoginResult> {
  const body = req.body as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.slice(0, 254) : "";
  const password = typeof body.password === "string" ? body.password : "";
  await ctx.rateLimiter.consume(limits.login(req.ip, email));
  const user = email && password ? await ctx.users.authenticate(email, password) : undefined;
  if (!user) {
    req.log.info({ event: "login_failed" }, "login failed");
    return { ok: false, email, error: GENERIC_LOGIN_ERROR };
  }
  req.log.info({ event: "login_succeeded", userId: user.id }, "login succeeded");
  return { ok: true, user };
}

type SignupResult =
  | { ok: true; user: User }
  | { ok: false; values: { name?: string; email?: string }; errors: Record<string, string> };

export async function attemptSignup(ctx: Context, req: FastifyRequest): Promise<SignupResult> {
  await ctx.rateLimiter.consume(limits.signup(req.ip));
  const body = req.body as Record<string, unknown>;
  const values = {
    name: typeof body.name === "string" ? body.name.slice(0, 100) : "",
    email: typeof body.email === "string" ? body.email.slice(0, 254) : "",
  };
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) errors[String(issue.path[0] ?? "form")] ??= issue.message;
    return { ok: false, values, errors };
  }
  try {
    const user = await ctx.users.create(parsed.data);
    await ctx.emailVerification.send(user);
    req.log.info({ event: "signup", userId: user.id }, "account created");
    return { ok: true, user };
  } catch (err) {
    if (err instanceof EmailTakenError) {
      // This reveals that the address is registered. Signup can't avoid that
      // without email-first verification; rate limits bound the enumeration.
      return { ok: false, values, errors: { email: "That email already has a Kingdom account. Try signing in." } };
    }
    throw err;
  }
}

function setSessionCookie(ctx: Context, reply: FastifyReply, token: string) {
  reply.setCookie(ctx.sessionCookie, token, cookieOptions(ctx.config.secureCookies, ctx.config.SESSION_TTL_SECONDS));
}

/** Signs the browser in as `user`. Always a new session ID, so a planted cookie can't be fixed. */
export async function newSession(ctx: Context, req: FastifyRequest, reply: FastifyReply, user: User) {
  const previous = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
  if (previous) await ctx.sessions.revoke(previous.session.id);
  const { token, session } = await ctx.sessions.create({
    userId: user.id,
    amr: ["pwd"],
    ip: req.ip,
    ...(req.headers["user-agent"] ? { userAgent: req.headers["user-agent"] } : {}),
  });
  setSessionCookie(ctx, reply, token);
  return session;
}

/** Sign-in, sign-up and account pages reached directly rather than from an app. */
export function registerAccountRoutes(app: FastifyInstance, ctx: Context) {
  const loginPage = (req: FastifyRequest, reply: FastifyReply, extra: { email?: string; error?: string } = {}) =>
    LoginPage({ action: "/login", signupHref: "/signup", csrf: ctx.csrf.token(req, reply), ...extra });
  const signupPage = (req: FastifyRequest, reply: FastifyReply) => ({
    action: "/signup",
    loginHref: "/login",
    csrf: ctx.csrf.token(req, reply),
  });

  app.get("/", async (_req, reply) => reply.redirect("/account", 303));

  app.get("/login", async (req, reply) => sendPage(reply, loginPage(req, reply)));
  app.post("/login", async (req, reply) => {
    ctx.csrf.verify(req);
    const result = await attemptLogin(ctx, req);
    if (!result.ok) return sendPage(reply, loginPage(req, reply, { email: result.email, error: result.error }), 401);
    await newSession(ctx, req, reply, result.user);
    return reply.redirect("/account", 303);
  });

  app.get("/signup", async (req, reply) => sendPage(reply, SignupPage(signupPage(req, reply))));
  app.post("/signup", async (req, reply) => {
    ctx.csrf.verify(req);
    const result = await attemptSignup(ctx, req);
    if (!result.ok) {
      return sendPage(reply, SignupPage({ ...signupPage(req, reply), values: result.values, errors: result.errors }), 400);
    }
    await newSession(ctx, req, reply, result.user);
    return reply.redirect("/account", 303);
  });

  app.get("/account", async (req, reply) => {
    const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
    if (!active) return reply.redirect("/login", 303);
    const { user } = active;
    return sendPage(
      reply,
      AccountPage({ name: user.name, email: user.email, emailVerified: user.emailVerified, csrf: ctx.csrf.token(req, reply) }),
    );
  });

  app.post("/logout", async (req, reply) => {
    ctx.csrf.verify(req);
    await signOut(ctx, req, reply);
    return reply.redirect("/login", 303);
  });

  app.get<{ Querystring: { token?: string } }>("/verify-email", async (req, reply) => {
    const userId = req.query.token ? await ctx.emailVerification.consume(req.query.token) : undefined;
    if (!userId) {
      return sendPage(
        reply,
        MessagePage({ title: "Link expired", message: "This verification link is invalid or has already been used.", tone: "error" }),
        400,
      );
    }
    await ctx.users.markEmailVerified(userId);
    return sendPage(reply, MessagePage({ title: "Email verified", message: "Thanks. Your email address is confirmed." }));
  });
}
