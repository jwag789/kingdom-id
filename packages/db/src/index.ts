import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function connect(url: string, options: { max?: number } = {}): DatabaseHandle {
  const sql = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}

// Migrations ship next to the compiled code's parent, so this path resolves
// from both src/ (development) and dist/ (production).
export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// Instances start at the same time and all migrate on boot; an advisory
// lock makes them take turns, so the second finds nothing left to do.
const MIGRATION_LOCK_ID = 0x4b49_444d; // "KIDM"

export async function runMigrations(url: string): Promise<void> {
  // max: 1 keeps the lock and the migration on the same session.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}
