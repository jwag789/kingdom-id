/** Grants (or with --revoke, removes) admin to an account: `pnpm --filter @kingdom-id/idp make-admin you@example.com`. */
import { connect, users } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error("usage: make-admin <email> [--revoke]");
  process.exit(1);
}
const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL, { max: 1 });
const updated = await db
  .update(users)
  .set({ isAdmin: flag !== "--revoke" })
  .where(eq(users.email, email.trim().toLowerCase()))
  .returning({ id: users.id });
await close();
if (updated.length === 0) {
  console.error(`no account for ${email}`);
  process.exit(1);
}
console.log(`${email} is ${flag === "--revoke" ? "no longer" : "now"} an admin`);
