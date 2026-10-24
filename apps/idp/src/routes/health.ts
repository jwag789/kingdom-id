import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Context } from "../context.js";

export function registerHealthRoutes(app: FastifyInstance, ctx: Context) {
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await Promise.all([ctx.db.execute(sql`select 1`), ctx.redis.ping()]);
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });
}
