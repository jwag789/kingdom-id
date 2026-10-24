import type { JWTPayload } from "jose";
import { compactVerify, createLocalJWKSet, decodeJwt } from "jose";
import type { KeyStore } from "../keys/keystore.js";

/**
 * Validates an `id_token_hint` (authorization and logout requests). The hint
 * may be expired (OIDC Core §3.1.2.1, RP-Initiated Logout §2), so only the
 * signature and issuer are checked; callers check `aud`, `sub` and `sid`.
 */
export async function verifyIdTokenHint(keys: KeyStore, issuer: string, hint: string): Promise<JWTPayload | undefined> {
  try {
    await compactVerify(hint, createLocalJWKSet(await keys.jwks()));
    const payload = decodeJwt(hint);
    return payload.iss === issuer ? payload : undefined;
  } catch {
    return undefined;
  }
}

export const audiences = (payload: JWTPayload) => (Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []);
