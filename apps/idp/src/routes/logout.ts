import type { Client } from "@kingdom-id/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { JWTPayload } from "jose";
import type { Context } from "../context.js";
import { buildRedirect } from "../oauth/authorize.js";
import { audiences, verifyIdTokenHint } from "../oauth/id-token-hint.js";
import { sessionIdFor } from "../oauth/subject.js";
import { cookieOptions } from "../security/cookies.js";
import { sendPage } from "../views/layout.js";
import { LogoutPage, MessagePage } from "../views/pages.js";

/** Ends the browser's Kingdom session and the online grants that rode on it. */
export async function signOut(ctx: Context, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
  if (active) {
    await ctx.sessions.revoke(active.session.id);
    await ctx.grants.revokeOnlineForSession(active.session.id);
    req.log.info({ event: "logout", userId: active.user.id }, "signed out");
  }
  reply.clearCookie(ctx.sessionCookie, cookieOptions(ctx.config.secureCookies));
}

type Params = Record<string, string | string[] | undefined>;

interface LogoutRequest {
  client?: Client;
  redirectUri?: string;
  state?: string;
  hint?: JWTPayload;
}

/** OpenID Connect RP-Initiated Logout 1.0. */
export function registerLogoutRoutes(app: FastifyInstance, ctx: Context) {
  const handler = async (req: FastifyRequest, reply: FastifyReply, params: Params) => {
    const parsed = await parseLogoutRequest(ctx, params);
    if ("error" in parsed) {
      return sendPage(reply, MessagePage({ title: "Sign-out link not recognized", message: parsed.error, tone: "error" }), 400);
    }
    const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
    if (!active) return finish(reply, parsed);

    // If the app proves it knows this exact session (its ID token's sid), the
    // request is the app acting for the user: sign out without asking.
    // Otherwise anyone could link a user to a sign-out, so confirm first.
    const { client, hint } = parsed;
    if (client && hint && hint.sid === sessionIdFor(ctx.serverSecret, client.id, active.session.id)) {
      await signOut(ctx, req, reply);
      return finish(reply, parsed);
    }

    if (parsed.redirectUri) req.formActionSources.push(new URL(parsed.redirectUri).origin);
    return sendPage(
      reply,
      LogoutPage({
        csrf: ctx.csrf.token(req, reply),
        email: active.user.email,
        appName: client?.name,
        hidden: {
          client_id: client?.id,
          post_logout_redirect_uri: parsed.redirectUri,
          state: parsed.state,
        },
      }),
    );
  };

  app.get("/end-session", (req, reply) => handler(req, reply, req.query as Params));
  app.post("/end-session", (req, reply) => handler(req, reply, (req.body ?? {}) as Params));

  app.post("/end-session/confirm", async (req, reply) => {
    ctx.csrf.verify(req);
    const body = req.body as Params;
    // Re-validate: the hidden fields came back from the browser.
    const parsed = await parseLogoutRequest(ctx, { ...body, id_token_hint: undefined });
    if ("error" in parsed) {
      return sendPage(reply, MessagePage({ title: "Sign-out link not recognized", message: parsed.error, tone: "error" }), 400);
    }
    if (body.decision !== "logout") return reply.redirect("/account", 303);
    await signOut(ctx, req, reply);
    return finish(reply, parsed);
  });
}

async function parseLogoutRequest(ctx: Context, params: Params): Promise<LogoutRequest | { error: string }> {
  for (const value of Object.values(params)) {
    if (Array.isArray(value)) return { error: "The sign-out request repeated a parameter." };
  }
  const p = params as Record<string, string | undefined>;
  // An invalid or foreign hint is ignored rather than fatal: worst case the
  // user is asked to confirm.
  const hint = p.id_token_hint ? await verifyIdTokenHint(ctx.keys, ctx.config.ISSUER, p.id_token_hint) : undefined;
  const hintAud = hint ? audiences(hint) : [];

  let clientId = p.client_id;
  if (clientId && hint && !hintAud.includes(clientId)) {
    return { error: "The sign-out request named one app but carried another app's token." };
  }
  clientId ??= hintAud.length === 1 ? hintAud[0] : undefined;
  const client = clientId ? await ctx.clients.find(clientId) : undefined;

  let redirectUri: string | undefined;
  if (p.post_logout_redirect_uri) {
    // Exact match against the client's registered post-logout URIs, same rule
    // as authorization redirects. No match, no redirect.
    if (!client || !client.postLogoutRedirectUris.includes(p.post_logout_redirect_uri)) {
      return { error: "The app asked to send you to an address it hasn't registered, so Kingdom ID stopped here." };
    }
    redirectUri = p.post_logout_redirect_uri;
  }
  return {
    ...(client ? { client } : {}),
    ...(redirectUri ? { redirectUri } : {}),
    ...(p.state ? { state: p.state.slice(0, 1024) } : {}),
    ...(hint ? { hint } : {}),
  };
}

function finish(reply: FastifyReply, request: LogoutRequest) {
  if (request.redirectUri) return reply.redirect(buildRedirect(request.redirectUri, { state: request.state }), 303);
  return sendPage(reply, MessagePage({ title: "You're signed out", message: "You've signed out of your Kingdom account." }));
}
