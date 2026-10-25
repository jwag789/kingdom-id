import { type User, clients } from "@kingdom-id/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ACR_PHISHING_RESISTANT, acrFor } from "../accounts/auth-methods.js";
import type { Context } from "../context.js";
import { PerkError, perkInput } from "../oauth/perks.js";
import { AdminPage } from "../views/admin.js";
import { sendPage, uiFor } from "../views/layout.js";
import { MessagePage } from "../views/pages.js";

/**
 * Perks admin. Requires an admin account signed in with a passkey: admin
 * powers shouldn't be one phished password away.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: Context) {
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<User | undefined> {
    const active = await ctx.sessions.resolve(req.cookies[ctx.sessionCookie]);
    if (!active) {
      await reply.redirect("/login", 303);
      return undefined;
    }
    if (!active.user.isAdmin) {
      await sendPage(reply, MessagePage({ ui: uiFor(ctx, req), title: "Not available", message: "This page is for Kingdom ID administrators.", tone: "error" }), 403);
      return undefined;
    }
    if (acrFor(active.session.amr) !== ACR_PHISHING_RESISTANT) {
      await sendPage(
        reply,
        MessagePage({
          ui: uiFor(ctx, req),
          title: "Sign in with a passkey",
          message: "Admin needs a passkey sign-in. Sign out, then sign back in with your passkey.",
          tone: "error",
        }),
        403,
      );
      return undefined;
    }
    return active.user;
  }

  const page = async (
    req: FastifyRequest,
    reply: FastifyReply,
    user: User,
    extra: { notice?: string; error?: string; values?: Record<string, string>; errors?: Record<string, string> } = {},
  ) =>
    AdminPage({
      ui: uiFor(ctx, req),
      csrf: ctx.csrf.token(req, reply),
      user: { name: user.name },
      clients: await ctx.db.select().from(clients).orderBy(clients.name),
      perks: await ctx.perks.listWithClients(),
      ...extra,
    });

  const audit = (req: FastifyRequest, user: User, action: string, details: object) =>
    req.log.info({ event: "admin_action", adminId: user.id, action, ...details }, "admin action");

  app.get<{ Querystring: { done?: string } }>("/admin", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    return sendPage(reply, await page(req, reply, user, req.query.done ? { notice: req.query.done.slice(0, 120) } : {}));
  });

  app.post("/admin/perks", async (req, reply) => {
    ctx.csrf.verify(req);
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const body = req.body as Record<string, string>;
    const values = { ...body, threshold: body.threshold || undefined } as Record<string, string | undefined>;
    const parsed = perkInput.safeParse(values);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
      return sendPage(reply, await page(req, reply, user, { values: body, errors }), 400);
    }
    if (!(await ctx.clients.find(parsed.data.clientId))) {
      return sendPage(reply, await page(req, reply, user, { values: body, error: "That app doesn't exist." }), 400);
    }
    try {
      const perk = await ctx.perks.create(parsed.data);
      audit(req, user, "perk_created", { perkId: perk.id, slug: perk.slug });
      return reply.redirect(`/admin?done=${encodeURIComponent(`Created ${perk.name}.`)}`, 303);
    } catch (err) {
      if (err instanceof PerkError) return sendPage(reply, await page(req, reply, user, { values: body, errors: { slug: err.message } }), 400);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/admin/perks/:id/toggle", async (req, reply) => {
    ctx.csrf.verify(req);
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const perk = (await ctx.perks.listWithClients()).find((p) => p.perk.id === req.params.id)?.perk;
    if (!perk) return reply.redirect("/admin", 303);
    await ctx.perks.setActive(perk.id, !perk.active);
    audit(req, user, perk.active ? "perk_paused" : "perk_resumed", { perkId: perk.id });
    return reply.redirect(`/admin?done=${encodeURIComponent(`${perk.active ? "Paused" : "Resumed"} ${perk.name}.`)}`, 303);
  });

  app.post<{ Params: { id: string } }>("/admin/perks/:id/delete", async (req, reply) => {
    ctx.csrf.verify(req);
    const user = await requireAdmin(req, reply);
    if (!user) return;
    await ctx.perks.remove(req.params.id);
    audit(req, user, "perk_deleted", { perkId: req.params.id });
    return reply.redirect(`/admin?done=${encodeURIComponent("Perk deleted.")}`, 303);
  });

  app.post<{ Params: { id: string } }>("/admin/perks/:id/grant", async (req, reply) => {
    ctx.csrf.verify(req);
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const email = String((req.body as Record<string, unknown>).email ?? "");
    try {
      await ctx.perks.grant(req.params.id, email);
    } catch (err) {
      if (err instanceof PerkError) return sendPage(reply, await page(req, reply, user, { error: err.message }), 400);
      throw err;
    }
    audit(req, user, "perk_granted", { perkId: req.params.id });
    return reply.redirect(`/admin?done=${encodeURIComponent(`Granted to ${email}.`)}`, 303);
  });
}
