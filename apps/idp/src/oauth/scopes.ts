import type { User } from "@kingdom-id/db";

export const SUPPORTED_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
export type Scope = (typeof SUPPORTED_SCOPES)[number];

/** Standard claims released per scope (OIDC Core §5.4), limited to what Kingdom ID stores. */
export const SCOPE_CLAIMS: Record<Scope, readonly string[]> = {
  openid: ["sub"],
  profile: ["name", "updated_at"],
  email: ["email", "email_verified"],
  offline_access: [],
};

export const CLAIMS_SUPPORTED = [
  ...new Set(["iss", "aud", "exp", "iat", "auth_time", "nonce", "amr", "sid", "at_hash", ...Object.values(SCOPE_CLAIMS).flat()]),
];

/** Plain-language descriptions for the consent screen. */
export const SCOPE_DESCRIPTIONS: Record<Scope, string | null> = {
  openid: null, // implied by signing in at all
  profile: "Your name",
  email: "Your email address",
  offline_access: "Stay connected when you're not using it, until you disconnect it",
};

/** Splits a scope parameter, dropping duplicates and anything we don't support (RFC 6749 §3.3 lets us narrow). */
export function parseScope(raw: string | undefined, allowed: readonly string[]): Scope[] {
  const requested = new Set((raw ?? "").split(" ").filter(Boolean));
  return SUPPORTED_SCOPES.filter((s) => requested.has(s) && allowed.includes(s));
}

export function userClaims(user: User, scopes: readonly string[]): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  if (scopes.includes("profile")) {
    claims.name = user.name;
    claims.updated_at = Math.floor(user.updatedAt.getTime() / 1000);
  }
  if (scopes.includes("email")) {
    claims.email = user.email;
    claims.email_verified = user.emailVerified;
  }
  return claims;
}
