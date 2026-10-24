/** Recreates the e2e database and flushes the e2e Redis DB before Playwright starts the servers. */
import { Redis } from "ioredis";
import postgres from "postgres";
import { env } from "./env.js";

const target = new URL(env.DATABASE_URL);
const name = target.pathname.slice(1);
const admin = new URL(env.DATABASE_URL);
admin.pathname = "/postgres";

const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
await sql.unsafe(`drop database if exists ${name} with (force)`);
await sql.unsafe(`create database ${name}`);
await sql.end();

const redis = new Redis(env.REDIS_URL);
await redis.flushdb();
await redis.quit();
console.log(`prepared ${name}`);
