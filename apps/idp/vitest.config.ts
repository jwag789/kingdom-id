import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"] } },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Integration tests share one Postgres and one Redis container; files run
    // in parallel but each test creates its own users and clients.
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
