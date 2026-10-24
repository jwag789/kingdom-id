import type { Client, Session, User } from "@kingdom-id/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { compactVerify, createLocalJWKSet, decodeJwt } from "jose";
import type { Context } from "../context.js";
import {
  type AuthorizationRequest,
  RedirectableError,
  UntrustedRedirectError,
  buildRedirect,
  parseAuthorizationRequest,
} from "../oauth/authorize.js";
import { covers } from "../oauth/consents.js";
import { subjectFor } from "../oauth/subject.js";
import { limits } from "../security/rate-limit.js";
import { sendPage } from "../views/layout.js";
import { MessagePage } from "../views/pages.js";

export function registerAuthorizeRoutes(app: FastifyInstance, ctx: Context) {
  // OIDC Core §3.1.2.1: the authorization endpoint must accept GET and POST.
  app.get("/authorize", (req, reply) => authorize(ctx, req, reply, req.query as Params));
  app.post("/authorize", (req, reply) => authorize(ctx, req, reply, (req.body ?? {}) as Params));
}

type Params = Record<string, string | string[] | undefined>;

async function authorize(ctx: Context, req: FastifyRequest, reply: FastifyReply, params: Params) {
  await ctx.rateLimiter.consume(limits.authorize(req.ip));

  let client: Client;
  let request: AuthorizationRequest;
  try {
    ({ client, request } = await parseAuthorizationRequest(params, (id) => ctx.clients.find(id)));
  } catch (err) {
    if (err instanceof UntrustedRedirectError) {
      return sendPage(reply, MessagePage({ title: err.title, message: err.detail, tone: "error" }), 400);
    }
    if (err instanceof RedirectableError) return redirectError(ctx, reply, err);
    throw err;
  }

  const browserId = ctx.csrf.browserId(req, reply);
  const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
  const needsLogin = !active || (await mustReauthenticate(ctx, client, request, active.session, active.user));

  if (request.prompt.includes("none")) {
    const fail = (code: string, description: string) =>
      redirectError(ctx, reply, new RedirectableError(code, description, request.redirectUri, request.state));
    if (needsLogin) return fail("login_required", "the user must sign in");
    if (!covers(await ctx.consents.get(active!.user.id, client.id), request.scopes)) {
      return fail("consent_required", "the user hasn't approved this app");
    }
    return completeAuthorization(ctx, reply, client, request, active!.session, active!.user);
  }

  if (!needsLogin && !request.prompt.includes("consent")) {
    if (covers(await ctx.consents.get(active!.user.id, client.id), request.scopes)) {
      return completeAuthorization(ctx, reply, client, request, active!.session, active!.user);
    }
  }

  const interaction = await ctx.interactions.create(browserId, request, needsLogin && !!active);
  return reply.redirect(`/interaction/${interaction.id}`, 303);
}

/** Whether an existing session is not good enough for this request (prompt, max_age, id_token_hint). */
async function mustReauthenticate(
  ctx: Context,
  client: Client,
  request: AuthorizationRequest,
  session: Session,
  user: User,
): Promise<boolean> {
  const forced = ["login", "select_account", "create"] as const;
  if (request.prompt.some((p) => (forced as readonly string[]).includes(p))) return true;
  if (request.maxAge !== undefined) {
    const age = Math.floor((Date.now() - session.authTime.getTime()) / 1000);
    if (age > request.maxAge) return true;
  }
  if (request.idTokenHint) {
    // The hint may be expired (OIDC Core §3.1.2.1), so only the signature,
    // issuer and audience are checked, then its sub is compared.
    try {
      await compactVerify(request.idTokenHint, createLocalJWKSet(await ctx.keys.jwks()));
      const hint = decodeJwt(request.idTokenHint);
      const aud = Array.isArray(hint.aud) ? hint.aud : [hint.aud];
      if (hint.iss !== ctx.config.ISSUER || !aud.includes(client.id)) return true;
      if (hint.sub !== subjectFor(ctx.serverSecret, client, user.id)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Issues the authorization code and sends the browser back to the client. */
export async function completeAuthorization(
  ctx: Context,
  reply: FastifyReply,
  client: Client,
  request: AuthorizationRequest,
  session: Session,
  user: User,
) {
  const sub = subjectFor(ctx.serverSecret, client, user.id);
  const code = await ctx.codes.issue({
    clientId: client.id,
    userId: user.id,
    sessionId: session.id,
    sub,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    codeChallenge: request.codeChallenge,
    authTime: Math.floor(session.authTime.getTime() / 1000),
    amr: session.amr,
    ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
  });
  // `iss` lets the client detect mix-up attacks (RFC 9207).
  return reply.redirect(buildRedirect(request.redirectUri, { code, state: request.state, iss: ctx.config.ISSUER }), 303);
}

export function redirectError(ctx: Context, reply: FastifyReply, err: RedirectableError) {
  return reply.redirect(
    buildRedirect(err.redirectUri, {
      error: err.code,
      error_description: err.description,
      state: err.state,
      iss: ctx.config.ISSUER,
    }),
    303,
  );
}
