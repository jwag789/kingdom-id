import { defineConfig, devices } from "@playwright/test";
import { env } from "./env.js";

const shared = { env: { ...process.env, ...env } as Record<string, string>, reuseExistingServer: !process.env.CI, timeout: 60_000 };

export default defineConfig({
  testDir: "tests",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { ...shared, command: "pnpm --filter @kingdom-id/idp start:src", url: "http://localhost:4000/readyz" },
    { ...shared, command: "pnpm --filter @kingdom-id/demo-client start", url: "http://localhost:4001/" },
    {
      ...shared,
      // The Next.js integration example, built and run exactly as a deployment would.
      command: "pnpm --filter @kingdom-id/example-cappuccino build && pnpm --filter @kingdom-id/example-cappuccino start",
      url: "http://localhost:4002/",
      timeout: 180_000,
      env: {
        ...shared.env,
        KINGDOM_ISSUER: "http://localhost:4000",
        AUTH_KINGDOM_ID: "cappuccino",
        AUTH_KINGDOM_SECRET: env.CAPPUCCINO_CLIENT_SECRET,
        AUTH_SECRET: "e2e-auth-js-secret-not-for-production-000000",
        AUTH_URL: "http://localhost:4002",
        NODE_ENV: "production",
      },
    },
  ],
});
