import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { runMigrations } from "@kingdom-id/db";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/** One real Postgres and one real Redis for the whole run. No mocks of either. */
export default async function setup(project: TestProject) {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer("postgres:17-alpine").start(),
    new RedisContainer("redis:7.4-alpine").start(),
  ]);
  const databaseUrl = pg.getConnectionUri();
  await runMigrations(databaseUrl);
  project.provide("databaseUrl", databaseUrl);
  project.provide("redisUrl", redis.getConnectionUrl());
  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}
