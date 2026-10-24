import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  ISSUER: "https://id.example.com/",
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  SERVER_SECRET: Buffer.alloc(32).toString("base64"),
};

describe("config", () => {
  it("normalizes the issuer and enables secure cookies for https", () => {
    const config = loadConfig(base);
    expect(config.ISSUER).toBe("https://id.example.com");
    expect(config.secureCookies).toBe(true);
  });

  it("refuses a plain-http issuer in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", ISSUER: "http://id.example.com" })).toThrow(/https/);
  });

  it("refuses a short key-encryption key", () => {
    expect(() => loadConfig({ ...base, KEY_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/KEY_ENCRYPTION_KEY/);
  });

  it("refuses an issuer with a query", () => {
    expect(() => loadConfig({ ...base, ISSUER: "https://id.example.com/?x=1" })).toThrow(/query/);
  });
});
