import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, safeEqual } from "../../src/lib/crypto.js";
import { leftHalfHash } from "../../src/oauth/tokens.js";

describe("key encryption at rest", () => {
  const key = randomBytes(32);

  it("round-trips", () => {
    expect(decrypt(key, encrypt(key, "secret jwk", "kid-1"), "kid-1")).toBe("secret jwk");
  });

  it("refuses a ciphertext moved to another key ID (AAD binding)", () => {
    expect(() => decrypt(key, encrypt(key, "secret jwk", "kid-1"), "kid-2")).toThrow();
  });

  it("refuses tampered ciphertext", () => {
    const ct = Buffer.from(encrypt(key, "secret jwk", "kid-1"), "base64url");
    ct[ct.length - 1]! ^= 1;
    expect(() => decrypt(key, ct.toString("base64url"), "kid-1")).toThrow();
  });

  it("refuses the wrong key", () => {
    expect(() => decrypt(randomBytes(32), encrypt(key, "secret jwk", "kid-1"), "kid-1")).toThrow();
  });
});

describe("safeEqual", () => {
  it("compares correctly, including different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("at_hash", () => {
  it("is the base64url left half of SHA-256", () => {
    // Expected value computed independently:
    // printf %s TOKEN | openssl dgst -sha256 -binary | head -c 16 | base64 (url-safe, unpadded)
    expect(leftHalfHash("jHkWEdUXMU1BwAsC4vtUsZwnNTbXt9lP")).toBe("XfrDI-Y6cbfsL96kwr5spg");
  });
});
