import { execFileSync } from "node:child_process";
import { env } from "./env.js";

/** Migrates and registers the demo client with a known secret before the servers start. */
export default function globalSetup() {
  execFileSync("pnpm", ["--filter", "@kingdom-id/idp", "seed"], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}
