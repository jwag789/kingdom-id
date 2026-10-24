import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/lib/crypto.js";
import { isValidChallenge, verifyPkce } from "../../src/oauth/pkce.js";

describe("PKCE (RFC 7636)", () => {
  it("matches the RFC 7636 Appendix B test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(sha256(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("rejects a wrong, missing, short, long, or malformed verifier", () => {
    const challenge = sha256("a".repeat(43));
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce("a".repeat(42), sha256("a".repeat(42)))).toBe(false);
    expect(verifyPkce("a".repeat(129), sha256("a".repeat(129)))).toBe(false);
    expect(verifyPkce(`${"a".repeat(42)}!`, sha256(`${"a".repeat(42)}!`))).toBe(false);
  });

  it("only accepts S256-shaped challenges", () => {
    expect(isValidChallenge(sha256("x"))).toBe(true);
    expect(isValidChallenge("too-short")).toBe(false);
    expect(isValidChallenge(`${"a".repeat(42)}=`)).toBe(false);
  });
});
