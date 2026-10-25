import type { Client, Session, User } from "@kingdom-id/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import {
  type AuthorizationRequest,
  RedirectableError,
  UntrustedRedirectError,
  buildRedirect,
  parseAuthorizationRequest,
} from "../oauth/authorize.js";
import { acrFor } from "../accounts/auth-methods.js";
import { covers } from "../oauth/consents.js";
import { audiences, verifyIdTokenHint } from "../oauth/id-token-hint.js";
import { subjectFor } from "../oauth/subject.js";
import { limits } from "../security/rate-limit.js";
import { sendPage, uiFor } from "../views/layout.js";
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
      return sendPage(reply, MessagePage({ ui: uiFor(ctx, req), title: err.title, message: err.detail, tone: "error" }), 400);
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
  // acr_values is voluntary (OIDC Core §3.1.2.1), but when an app asks for a
  // level the current session didn't reach, such as a passkey after a
  // password sign-in, the user gets the chance to step up.
  if (request.acrValues && !request.acrValues.includes(acrFor(session.amr))) return true;
  if (request.idTokenHint) {
    // A hint for someone else (or an unverifiable one) means the app expects
    // a different user than the one signed in.
    const hint = await verifyIdTokenHint(ctx.keys, ctx.config.ISSUER, request.idTokenHint);
    if (!hint || !audiences(hint).includes(client.id)) return true;
    if (hint.sub !== subjectFor(ctx.serverSecret, client, user.id)) return true;
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
    ...(request.codeChallenge ? { codeChallenge: request.codeChallenge } : {}),
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
