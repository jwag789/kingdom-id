import { connect, runMigrations } from "@kingdom-id/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SIGNING_ALGS, startRotationScheduler } from "./keys/keystore.js";
import { connectRedis } from "./lib/redis.js";

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const database = connect(config.DATABASE_URL);
const redis = connectRedis(config.REDIS_URL);
const { app, ctx } = await buildApp({ config, db: database.db, redis });

await ctx.keys.ensureKeys();
await ctx.keys.rotateIfDue();
// Fail at boot, not at the first token request, if KEY_ENCRYPTION_KEY can't
// decrypt the stored keys (wrong key, or a database from another environment).
try {
  await Promise.all(SIGNING_ALGS.map((alg) => ctx.keys.getActiveKey(alg)));
} catch (err) {
  app.log.fatal({ err }, "cannot decrypt signing keys: check KEY_ENCRYPTION_KEY");
  process.exit(1);
}
const stopRotation = startRotationScheduler(ctx.keys, (err) => app.log.error({ err }, "key rotation failed"));
// Every instance consumes security events; the consumer group splits the work.
await ctx.eventStream.start();
await ctx.logoutStream.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopRotation();
  await app.close();
  await ctx.eventStream.stop();
  await ctx.logoutStream.stop();
  await Promise.all([database.close(), redis.quit()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
