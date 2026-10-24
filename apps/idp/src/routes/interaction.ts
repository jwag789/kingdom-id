import type { Client, Session, User } from "@kingdom-id/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { RedirectableError } from "../oauth/authorize.js";
import { covers } from "../oauth/consents.js";
import type { Interaction } from "../oauth/interactions.js";
import { subjectFor } from "../oauth/subject.js";
import { sendPage } from "../views/layout.js";
import { ConsentPage, LoginPage, MessagePage, SignupPage } from "../views/pages.js";
import { completeAuthorization, redirectError } from "./authorize.js";
import { attemptLogin, attemptSignup, newSession } from "./account.js";

interface Loaded {
  interaction: Interaction;
  client: Client;
}

export function registerInteractionRoutes(app: FastifyInstance, ctx: Context) {
  const base = (id: string) => `/interaction/${id}`;

  app.get<{ Params: { id: string } }>("/interaction/:id", async (req, reply) => {
    const loaded = await load(ctx, req, reply);
    if (!loaded) return;
    const { interaction, client } = loaded;
    const { request } = interaction;
    const rp = { name: client.name, logoUri: client.logoUri };

    const authenticated = await authenticatedFor(ctx, req, interaction);
    if (!authenticated) {
      if (request.prompt.includes("create") && !interaction.loginSessionId) {
        return sendPage(reply, SignupPage({ ...signupProps(ctx, req, reply, interaction.id), app: rp }));
      }
      return sendPage(
        reply,
        LoginPage({
          action: `${base(interaction.id)}/login`,
          signupHref: `${base(interaction.id)}/signup`,
          csrf: ctx.csrf.token(req, reply),
          app: rp,
          email: request.loginHint,
        }),
      );
    }

    const consent = await ctx.consents.get(authenticated.user.id, client.id);
    if (covers(consent, request.scopes) && !request.prompt.includes("consent")) {
      return finish(ctx, reply, loaded, authenticated);
    }
    return sendPage(
      reply,
      ConsentPage({
        action: `${base(interaction.id)}/consent`,
        csrf: ctx.csrf.token(req, reply),
        app: rp,
        host: new URL(request.redirectUri).host,
        userEmail: authenticated.user.email,
        scopes: request.scopes as never,
        switchHref: `${base(interaction.id)}/switch`,
      }),
    );
  });

  app.post<{ Params: { id: string } }>("/interaction/:id/login", async (req, reply) => {
    ctx.csrf.verify(req);
    const loaded = await load(ctx, req, reply);
    if (!loaded) return;
    const { interaction, client } = loaded;
    const result = await attemptLogin(ctx, req);
    if (!result.ok) {
      return sendPage(
        reply,
        LoginPage({
          action: `${base(interaction.id)}/login`,
          signupHref: `${base(interaction.id)}/signup`,
          csrf: ctx.csrf.token(req, reply),
          app: { name: client.name, logoUri: client.logoUri },
          email: result.email,
          error: result.error,
        }),
        401,
      );
    }
    await startSession(ctx, req, reply, interaction, result.user);
    return reply.redirect(base(interaction.id), 303);
  });

  app.get<{ Params: { id: string } }>("/interaction/:id/signup", async (req, reply) => {
    const loaded = await load(ctx, req, reply);
    if (!loaded) return;
    const rp = { name: loaded.client.name, logoUri: loaded.client.logoUri };
    return sendPage(reply, SignupPage({ ...signupProps(ctx, req, reply, loaded.interaction.id), app: rp }));
  });

  app.post<{ Params: { id: string } }>("/interaction/:id/signup", async (req, reply) => {
    ctx.csrf.verify(req);
    const loaded = await load(ctx, req, reply);
    if (!loaded) return;
    const result = await attemptSignup(ctx, req);
    if (!result.ok) {
      const rp = { name: loaded.client.name, logoUri: loaded.client.logoUri };
      return sendPage(
        reply,
        SignupPage({ ...signupProps(ctx, req, reply, loaded.interaction.id), app: rp, values: result.values, errors: result.errors }),
        400,
      );
    }
    await startSession(ctx, req, reply, loaded.interaction, result.user);
    return reply.redirect(base(loaded.interaction.id), 303);
  });

  // "Not you?": require a fresh sign-in for this interaction.
  app.get<{ Params: { id: string } }>("/interaction/:id/switch", async (req, reply) => {
    const loaded = await load(ctx, req, reply);
    if (!loaded) return;
    loaded.interaction.forceLogin = true;
    delete loaded.interaction.loginSessionId;
    await ctx.interactions.save(loaded.interaction);
    return reply.redirect(base(loaded.interaction.id), 303);
  });

  app.post<{ Params: { id: string } }>("/interaction/:id/consent", async (req, reply) => {
    ctx.csrf.verify(req);
    const loaded = await load(ctx, req, reply);
    if (!loaded) return;
    const { interaction, client } = loaded;
    const authenticated = await authenticatedFor(ctx, req, interaction);
    if (!authenticated) return reply.redirect(base(interaction.id), 303);

    const decision = (req.body as Record<string, unknown>).decision;
    if (decision !== "allow") {
      await ctx.interactions.consume(interaction.id);
      const { redirectUri, state } = interaction.request;
      return redirectError(ctx, reply, new RedirectableError("access_denied", "the user declined", redirectUri, state));
    }
    const sub = subjectFor(ctx.serverSecret, client, authenticated.user.id);
    await ctx.consents.grant(authenticated.user.id, client.id, sub, interaction.request.scopes);
    return finish(ctx, reply, loaded, authenticated);
  });
}

function signupProps(ctx: Context, req: FastifyRequest, reply: FastifyReply, id: string) {
  return {
    action: `/interaction/${id}/signup`,
    loginHref: `/interaction/${id}`,
    csrf: ctx.csrf.token(req, reply),
  };
}

/** Loads the interaction for this browser, or renders an "expired" page. */
async function load(ctx: Context, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<Loaded | undefined> {
  const browserId = req.cookies[ctx.csrf.cookie];
  const interaction = browserId ? await ctx.interactions.get(req.params.id, browserId) : undefined;
  const client = interaction ? await ctx.clients.find(interaction.request.clientId) : undefined;
  if (!interaction || !client) {
    await sendPage(
      reply,
      MessagePage({
        title: "This sign-in link has expired",
        message: "Go back to the app you were using and start signing in again.",
        tone: "error",
      }),
      400,
    );
    return undefined;
  }
  // Every form on an interaction page can end in a redirect chain to the
  // client (login → interaction → client), and Chrome checks form-action
  // against each hop.
  req.formActionSources.push(new URL(interaction.request.redirectUri).origin);
  return { interaction, client };
}

/** The session that may complete this interaction: any valid one, or only one created within it when re-auth was demanded. */
async function authenticatedFor(ctx: Context, req: FastifyRequest, interaction: Interaction) {
  const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
  if (!active) return undefined;
  if (interaction.forceLogin && active.session.id !== interaction.loginSessionId) return undefined;
  return active;
}

async function startSession(ctx: Context, req: FastifyRequest, reply: FastifyReply, interaction: Interaction, user: User) {
  const session = await newSession(ctx, req, reply, user);
  interaction.loginSessionId = session.id;
  await ctx.interactions.save(interaction);
}

async function finish(ctx: Context, reply: FastifyReply, loaded: Loaded, authenticated: { session: Session; user: User }) {
  // Exactly one request completes an interaction, even under a double submit.
  if (!(await ctx.interactions.consume(loaded.interaction.id))) {
    return sendPage(reply, MessagePage({ title: "Already finished", message: "This sign-in was already completed." }), 409);
  }
  return completeAuthorization(ctx, reply, loaded.client, loaded.interaction.request, authenticated.session, authenticated.user);
}
