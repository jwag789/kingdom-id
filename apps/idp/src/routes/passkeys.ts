import type { User } from "@kingdom-id/db";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { passkeyAmr } from "../accounts/auth-methods.js";
import { PasskeyError } from "../accounts/passkeys.js";
import { EmailTakenError, signupSchema } from "../accounts/users.js";
import type { Context } from "../context.js";
import { limits } from "../security/rate-limit.js";
import { newSession } from "./account.js";

type Body = Record<string, unknown>;

/**
 * JSON endpoints behind static/passkey.js. Each ceremony is two calls:
 * options (server picks a challenge) and the signed response. CSRF tokens
 * travel in the body like any form post.
 */
export function registerPasskeyRoutes(app: FastifyInstance, ctx: Context) {
  const fail = (reply: FastifyReply, status: number, error: string, fields?: Record<string, string>) =>
    reply.status(status).header("cache-control", "no-store").send({ error, ...(fields ? { fields } : {}) });

  app.post("/passkeys/authenticate/options", async (req, reply) => {
    ctx.csrf.verify(req);
    await ctx.rateLimiter.consume(limits.passkeyOptions(req.ip));
    reply.header("cache-control", "no-store");
    return ctx.passkeys.authenticationOptions(ctx.csrf.browserId(req, reply));
  });

  app.post("/passkeys/authenticate", async (req, reply) => {
    ctx.csrf.verify(req);
    const body = req.body as Body;
    try {
      const { user, amr } = await ctx.passkeys.authenticate(
        ctx.csrf.browserId(req, reply),
        body.response as AuthenticationResponseJSON,
      );
      req.log.info({ event: "login_succeeded", method: "passkey", userId: user.id }, "login succeeded");
      return { redirect: await signIn(ctx, req, reply, user, amr, body.interaction) };
    } catch (err) {
      if (err instanceof PasskeyError) {
        req.log.info({ event: "login_failed", method: "passkey" }, "passkey sign-in failed");
        return fail(reply, 400, err.message);
      }
      throw err;
    }
  });

  app.post("/passkeys/register/options", async (req, reply) => {
    ctx.csrf.verify(req);
    reply.header("cache-control", "no-store");
    const body = req.body as Body;
    const browserId = ctx.csrf.browserId(req, reply);

    if (body.mode === "add") {
      const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
      if (!active) return fail(reply, 401, "Sign in first.");
      return ctx.passkeys.registrationOptions(browserId, { kind: "add", user: active.user });
    }

    await ctx.rateLimiter.consume(limits.signup(req.ip));
    const parsed = signupSchema.omit({ password: true }).safeParse(body);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0])] ??= issue.message;
      return fail(reply, 400, "Check the highlighted fields.", fields);
    }
    // Checked up front so the user isn't asked to make a passkey for an
    // address that can't be used. Same disclosure as password signup.
    if (await ctx.users.emailExists(parsed.data.email)) {
      return fail(reply, 409, "That email already has a Kingdom account.", {
        email: "That email already has a Kingdom account. Try signing in.",
      });
    }
    return ctx.passkeys.registrationOptions(browserId, { kind: "signup", signup: parsed.data });
  });

  app.post("/passkeys/register", async (req, reply) => {
    ctx.csrf.verify(req);
    const body = req.body as Body;
    const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
    try {
      const { user, passkey } = await ctx.passkeys.register(ctx.csrf.browserId(req, reply), body.response as RegistrationResponseJSON);
      req.log.info({ event: "passkey_registered", userId: user.id, passkeyId: passkey.id }, "passkey registered");
      // Adding a passkey to a signed-in account keeps the current session.
      if (active && active.user.id === user.id) return { redirect: "/account?added=passkey" };
      await ctx.emailVerification.send(user);
      req.log.info({ event: "signup", method: "passkey", userId: user.id }, "account created");
      return { redirect: await signIn(ctx, req, reply, user, passkeyAmr(passkey.backedUp), body.interaction) };
    } catch (err) {
      if (err instanceof PasskeyError) return fail(reply, 400, err.message);
      if (err instanceof EmailTakenError) return fail(reply, 409, "That email already has a Kingdom account.");
      throw err;
    }
  });
}

/**
 * Starts a session and, if the sign-in happened inside an app's
 * authorization request, ties it to that interaction. Returns where the
 * browser should go next.
 */
async function signIn(ctx: Context, req: FastifyRequest, reply: FastifyReply, user: User, amr: string[], interactionId: unknown) {
  const session = await newSession(ctx, req, reply, user, amr);
  if (typeof interactionId === "string") {
    const interaction = await ctx.interactions.get(interactionId, ctx.csrf.browserId(req, reply));
    if (interaction) {
      interaction.loginSessionId = session.id;
      await ctx.interactions.save(interaction);
      return `/interaction/${interaction.id}`;
    }
  }
  return "/account";
}
