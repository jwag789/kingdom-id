import type { FastifyInstance } from "fastify";
import type { Context } from "../context.js";
import { BrandPage, parseButtonOptions } from "../views/brand.js";
import { sendPage, uiFor } from "../views/layout.js";

/** The Sign in with Kingdom button builder, for app developers. Public: no session needed. */
export function registerBrandRoutes(app: FastifyInstance, ctx: Context) {
  app.get<{ Querystring: Record<string, string> }>("/brand", async (req, reply) =>
    sendPage(reply, BrandPage({ ui: uiFor(ctx, req), issuer: ctx.config.ISSUER, options: parseButtonOptions(req.query) })),
  );
}
