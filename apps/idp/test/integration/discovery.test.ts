import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ISSUER, type TestApp, createTestApp } from "../helpers.js";

describe("discovery and JWKS", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("serves OpenID Provider metadata consistent with the issuer", async () => {
    const res = await t.app.inject("/.well-known/openid-configuration");
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.issuer).toBe(ISSUER);
    for (const k of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"]) {
      expect(doc[k]).toMatch(new RegExp(`^${ISSUER}/`));
    }
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.id_token_signing_alg_values_supported).toContain("RS256");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("serves the same document at the RFC 8414 location", async () => {
    const a = await t.app.inject("/.well-known/openid-configuration");
    const b = await t.app.inject("/.well-known/oauth-authorization-server");
    expect(b.json()).toEqual(a.json());
  });

  it("serves a JWKS with public keys only", async () => {
    const res = await t.app.inject("/.well-known/jwks.json");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/jwk-set+json");
    const { keys } = res.json();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys.every((k: Record<string, unknown>) => !("d" in k))).toBe(true);
    expect(new Set(keys.map((k: { alg: string }) => k.alg))).toEqual(new Set(["RS256", "ES256"]));
  });

  it("reports readiness", async () => {
    expect((await t.app.inject("/readyz")).json()).toEqual({ status: "ready" });
  });
});
