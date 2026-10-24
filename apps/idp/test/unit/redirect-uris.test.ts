import { describe, expect, it } from "vitest";
import { validateRedirectUris } from "../../src/oauth/clients.js";

describe("redirect URI registration", () => {
  it("accepts https and loopback http, returning the shared host", () => {
    expect(validateRedirectUris(["https://app.example.com/cb", "https://app.example.com/cb2"])).toBe("app.example.com");
    expect(validateRedirectUris(["http://localhost:3000/cb"])).toBe("localhost");
    expect(validateRedirectUris(["http://127.0.0.1:8080/cb"])).toBe("127.0.0.1");
  });

  it("rejects plain http to a real host", () => {
    expect(() => validateRedirectUris(["http://app.example.com/cb"])).toThrow(/https/);
  });

  it("rejects fragments", () => {
    expect(() => validateRedirectUris(["https://app.example.com/cb#x"])).toThrow(/fragment/);
  });

  it("rejects mixed hosts (pairwise sector must be unambiguous)", () => {
    expect(() => validateRedirectUris(["https://a.example.com/cb", "https://b.example.com/cb"])).toThrow(/one host/);
  });

  it("requires at least one", () => {
    expect(() => validateRedirectUris([])).toThrow();
  });
});
