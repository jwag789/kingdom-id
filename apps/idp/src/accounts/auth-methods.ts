/**
 * How a session was authenticated, expressed as `amr` (RFC 8176) and `acr`.
 *
 * `phr` is "phishing-resistant" from OpenID EAP ACR Values 1.0; a passkey
 * qualifies because the browser binds the assertion to our origin.
 */
export const ACR_PHISHING_RESISTANT = "phr";
export const ACR_PASSWORD = "urn:kingdom-id:acr:password";
export const ACR_VALUES_SUPPORTED = [ACR_PHISHING_RESISTANT, ACR_PASSWORD] as const;

export const AMR_PASSWORD = ["pwd"];

/**
 * A user-verified passkey: a key held in hardware (`hwk`) or synced across
 * devices (`swk`), plus user verification by biometric or PIN, which makes it
 * multi-factor on its own.
 */
export function passkeyAmr(backedUp: boolean): string[] {
  return [backedUp ? "swk" : "hwk", "user", "mfa"];
}

export function acrFor(amr: readonly string[]): string {
  return amr.includes("hwk") || amr.includes("swk") ? ACR_PHISHING_RESISTANT : ACR_PASSWORD;
}
