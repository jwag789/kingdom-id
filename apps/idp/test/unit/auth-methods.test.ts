import { describe, expect, it } from "vitest";
import { ACR_PASSWORD, ACR_PHISHING_RESISTANT, AMR_PASSWORD, acrFor, passkeyAmr } from "../../src/accounts/auth-methods.js";

describe("authentication methods", () => {
  it("maps passkeys to the phishing-resistant acr, with RFC 8176 amr values", () => {
    expect(passkeyAmr(true)).toEqual(["swk", "user", "mfa"]);
    expect(passkeyAmr(false)).toEqual(["hwk", "user", "mfa"]);
    expect(acrFor(passkeyAmr(true))).toBe(ACR_PHISHING_RESISTANT);
    expect(acrFor(passkeyAmr(false))).toBe(ACR_PHISHING_RESISTANT);
  });

  it("maps passwords to the password acr", () => {
    expect(acrFor(AMR_PASSWORD)).toBe(ACR_PASSWORD);
  });
});
