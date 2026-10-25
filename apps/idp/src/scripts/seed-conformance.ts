/**
 * Registers the OpenID conformance suite's static clients and test user.
 * Runs only inside the throwaway conformance environment (conformance/).
 *
 * The clients waive mandatory PKCE because the Basic OP test plan's modules
 * don't send it (one dedicated module checks that valid PKCE succeeds).
 */
import { clients, connect, runMigrations, users } from "@kingdom-id/db";
import { eq, inArray } from "drizzle-orm";
import { UserService } from "../accounts/users.js";
import { loadConfig } from "../config.js";
import { ClientService } from "../oauth/clients.js";

const config = loadConfig();
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const redirectUri = required("CONFORMANCE_REDIRECT_URI");
const email = required("CONFORMANCE_USER_EMAIL");
const password = required("CONFORMANCE_USER_PASSWORD");

const fixtures = [
  { id: "conformance-basic", secret: required("CONFORMANCE_CLIENT_SECRET"), method: "client_secret_basic" },
  { id: "conformance-basic-2", secret: required("CONFORMANCE_CLIENT2_SECRET"), method: "client_secret_basic" },
  { id: "conformance-post", secret: required("CONFORMANCE_CLIENT_POST_SECRET"), method: "client_secret_post" },
] as const;

await runMigrations(config.DATABASE_URL);
const { db, close } = connect(config.DATABASE_URL, { max: 1 });

await db.delete(clients).where(inArray(clients.id, fixtures.map((f) => f.id)));
const service = new ClientService(db);
for (const f of fixtures) {
  await service.create({
    id: f.id,
    name: "OpenID Conformance Suite",
    type: "confidential",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: f.method,
    subjectType: "public",
    requirePkce: false,
    secret: f.secret,
  });
}

await db.delete(users).where(eq(users.email, email));
const userService = new UserService(db);
const user = await userService.create({ name: "Conformance Tester", email, password });
await userService.markEmailVerified(user.id);
await close();
console.log(`seeded ${fixtures.length} conformance clients and ${email}`);
