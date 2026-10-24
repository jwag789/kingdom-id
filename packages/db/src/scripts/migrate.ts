import { runMigrations } from "../index.js";

const url = process.env.DATABASE_URL ?? "postgres://kingdom:kingdom@localhost:54320/kingdom_id";
await runMigrations(url);
console.log("migrations applied");
