/**
 * Registers the demo client (and prints its secret) so the end-to-end flow
 * works out of the box. Phase 8's `kingdom` CLI replaces this.
 */
import { clients, connect, runMigrations } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { ClientService } from "../oauth/clients.js";
import { PerkService } from "../oauth/perks.js";

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
  // A Kingdom-owned app: shares the first-party subject and may ask for perks.
  firstParty: true,
  postLogoutRedirectUris: [new URL("/", redirectUri).toString()],
  // Reuse a secret already in .env so re-seeding doesn't break a running demo.
  ...(process.env.DEMO_CLIENT_SECRET ? { secret: process.env.DEMO_CLIENT_SECRET } : {}),
});

// Sample perks so the Treasury has something to show. Deleted with the client above.
const perkService = new PerkService(db);
for (const perk of [
  { slug: "demo.explorer", name: "Explorer", description: "Welcome badge for trying the Kingdom demo.", rule: "connected" as const },
  { slug: "demo.loyal", name: "Regular", description: "10% off at Kingdom apps for a month of membership.", rule: "connected_days" as const, threshold: 30 },
  { slug: "demo.two-realms", name: "Two realms", description: "Early access to new apps once you use two Kingdom apps.", rule: "connected_apps" as const, threshold: 2 },
  { slug: "demo.founder", name: "Founding member", description: "Granted to the first Kingdom members.", rule: "manual" as const },
]) {
  await perkService.create({ clientId: id, ...perk });
}

// The Next.js example (examples/cappuccino), when a fixture secret is supplied.
if (process.env.CAPPUCCINO_CLIENT_SECRET) {
  await db.delete(clients).where(eq(clients.id, "cappuccino"));
  await new ClientService(db).create({
    id: "cappuccino",
    name: "Cappuccino",
    type: "confidential",
    firstParty: true,
    redirectUris: ["http://localhost:4002/api/auth/callback/kingdom"],
    postLogoutRedirectUris: ["http://localhost:4002/"],
    secret: process.env.CAPPUCCINO_CLIENT_SECRET,
  });
  console.log('Registered client "cappuccino" → http://localhost:4002');
}
await close();

console.log(`Registered client "${id}" → ${redirectUri}`);
console.log(`DEMO_CLIENT_ID=${id}`);
console.log(`DEMO_CLIENT_SECRET=${secret}`);
