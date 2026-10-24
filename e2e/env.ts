/**
 * Fixed configuration for the browser end-to-end run. The secrets are test
 * values that only ever protect a throwaway local database.
 */
export const env = {
  NODE_ENV: "test",
  ISSUER: "http://localhost:4000",
  PORT: "4000",
  // A dedicated database and Redis DB index, recreated each run, so local
  // development data (and its signing keys) can never leak into the e2e run.
  DATABASE_URL: "postgres://kingdom:kingdom@localhost:54320/kingdom_id_e2e",
  REDIS_URL: "redis://localhost:63790/1",
  KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SERVER_SECRET: Buffer.alloc(32, 2).toString("base64"),
  LOG_LEVEL: "warn",
  DEMO_CLIENT_ID: "kingdom-demo",
  DEMO_CLIENT_SECRET: "e2e-demo-secret-not-for-production-use-0000",
  DEMO_PORT: "4001",
};
