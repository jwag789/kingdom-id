/**
 * Registers the demo client (and prints its secret) so the end-to-end flow
 * works out of the box. Phase 8's `kingdom` CLI replaces this.
 */
import { clients, connect, runMigrations } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { ClientService } from "../oauth/clients.js";

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const { db, close } = connect(config.DATABASE_URL, { max: 1 });

const id = process.env.DEMO_CLIENT_ID ?? "kingdom-demo";
const redirectUri = process.env.DEMO_REDIRECT_URI ?? "http://localhost:4001/callback";

await db.delete(clients).where(eq(clients.id, id));
const { secret } = await new ClientService(db).create({
  id,
  name: "Kingdom Demo",
  type: "confidential",
  redirectUris: [redirectUri],
  // Reuse a secret already in .env so re-seeding doesn't break a running demo.
  ...(process.env.DEMO_CLIENT_SECRET ? { secret: process.env.DEMO_CLIENT_SECRET } : {}),
});
await close();

console.log(`Registered client "${id}" → ${redirectUri}`);
console.log(`DEMO_CLIENT_ID=${id}`);
console.log(`DEMO_CLIENT_SECRET=${secret}`);
