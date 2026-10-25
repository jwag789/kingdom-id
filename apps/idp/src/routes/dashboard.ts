import type { User } from "@kingdom-id/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PasskeyError } from "../accounts/passkeys.js";
import type { Context } from "../context.js";
import type { UnlockedPerk } from "../oauth/perks.js";
import {
  KeysPage,
  type LockedPerk,
  MasksPage,
  RealmsPage,
  type ShellProps,
  TreasuryPage,
  WatchtowerPage,
} from "../views/dashboard.js";
import { sendPage, uiFor } from "../views/layout.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Your Kingdom": Realms, Treasury, Masks, Watchtower and Keys. Every page needs a session. */
export function registerDashboardRoutes(app: FastifyInstance, ctx: Context) {
  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<User | undefined> {
    const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
    if (!active) {
      await reply.redirect("/login", 303);
      return undefined;
    }
    return active.user;
  }

  async function shell(req: FastifyRequest, reply: FastifyReply, user: User, extra: { notice?: string; error?: string } = {}) {
    const [realms, perks, keys] = await Promise.all([
      ctx.consents.listForUser(user.id),
      ctx.perks.unlockedFor(user.id),
      ctx.passkeys.listForUser(user.id),
    ]);
    const props: ShellProps = {
      ui: uiFor(ctx, req),
      csrf: ctx.csrf.token(req, reply),
      user: { name: user.name, email: user.email, isAdmin: user.isAdmin },
      stats: { realms: realms.length, perks: perks.length, keys: keys.length },
      ...extra,
    };
    return { props, realms, perks, keys };
  }

  app.get<{ Querystring: { disconnected?: string } }>("/account", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const notice = req.query.disconnected ? `Disconnected ${req.query.disconnected.slice(0, 80)}. Its access ended immediately.` : undefined;
    const { props, realms } = await shell(req, reply, user, notice ? { notice } : {});
    return sendPage(reply, RealmsPage({ ...props, realms }));
  });

  app.post<{ Params: { clientId: string } }>("/account/realms/:clientId/disconnect", async (req, reply) => {
    ctx.csrf.verify(req);
    const user = await requireUser(req, reply);
    if (!user) return;
    const client = await ctx.clients.find(req.params.clientId);
    if (!client) return reply.redirect("/account", 303);
    // Consent first, so a token request racing this can't re-mint against it;
    // then every grant, which kills refresh token families and access tokens.
    const hadConsent = await ctx.consents.remove(user.id, client.id);
    const revoked = await ctx.grants.revokeForUserClient(user.id, client.id, "disconnected_by_user");
    if (hadConsent || revoked > 0) {
      await ctx.events.record(req, { type: "app_disconnected", userId: user.id, clientId: client.id, details: { grantsRevoked: revoked } });
    }
    return reply.redirect(`/account?disconnected=${encodeURIComponent(client.name)}`, 303);
  });

  app.get("/account/treasury", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { props, realms, perks } = await shell(req, reply, user);
    const locked = (await ctx.perks.lockedFor(user.id)).map((p) => ({ ...p, hint: hintFor(p, realms) }));
    return sendPage(reply, TreasuryPage({ ...props, unlocked: perks, locked }));
  });

  app.get("/account/masks", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { props, realms } = await shell(req, reply, user);
    return sendPage(reply, MasksPage({ ...props, realms }));
  });

  app.get("/account/watchtower", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { props } = await shell(req, reply, user);
    const events = await ctx.events.listForUser(user.id);
    return sendPage(
      reply,
      WatchtowerPage({ ...props, events: events.map((e) => ({ ...e, event: { ...e.event, details: e.event.details as Record<string, unknown> } })) }),
    );
  });

  const keysPage = async (req: FastifyRequest, reply: FastifyReply, user: User, extra: { notice?: string; error?: string } = {}) => {
    const { props, keys } = await shell(req, reply, user, extra);
    return KeysPage({ ...props, passkeys: keys, hasPassword: !!user.passwordHash, emailVerified: user.emailVerified });
  };

  app.get<{ Querystring: { added?: string } }>("/account/keys", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const notice = req.query.added === "passkey" ? "Passkey added. You can use it to sign in now." : undefined;
    return sendPage(reply, await keysPage(req, reply, user, notice ? { notice } : {}));
  });

  app.post<{ Params: { id: string } }>("/account/passkeys/:id/delete", async (req, reply) => {
    ctx.csrf.verify(req);
    const user = await requireUser(req, reply);
    if (!user) return;
    try {
      await ctx.passkeys.remove(user, req.params.id);
    } catch (err) {
      if (err instanceof PasskeyError) return sendPage(reply, await keysPage(req, reply, user, { error: err.message }), 400);
      throw err;
    }
    req.log.info({ event: "passkey_removed", userId: user.id }, "passkey removed");
    await ctx.events.record(req, { type: "passkey_removed", userId: user.id });
    return reply.redirect("/account/keys", 303);
  });
}

/** What's left to do to unlock a perk, in plain words. */
function hintFor({ perk, appName }: UnlockedPerk, realms: { client: { id: string }; consent: { createdAt: Date } }[]): LockedPerk["hint"] {
  switch (perk.rule) {
    case "connected":
      return `Connect ${appName} to unlock`;
    case "connected_days": {
      const realm = realms.find((r) => r.client.id === perk.clientId);
      if (!realm) return `Connect ${appName} and stay for ${perk.threshold} days`;
      const days = Math.floor((Date.now() - realm.consent.createdAt.getTime()) / DAY_MS);
      return `${Math.max(1, (perk.threshold ?? 0) - days)} more days connected to ${appName}`;
    }
    case "connected_apps":
      return `Connect ${perk.threshold} Kingdom apps (you have ${realms.length})`;
    case "manual":
      return "Granted by the Kingdom team";
  }
}
