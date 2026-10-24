import { safeEqual, sha256 } from "../lib/crypto.js";

// RFC 7636 §4.1: 43–128 characters from the unreserved set.
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
// An S256 challenge is base64url(SHA-256(verifier)): exactly 43 characters.
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export const isValidChallenge = (challenge: string) => S256_CHALLENGE.test(challenge);

export function verifyPkce(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || !VERIFIER.test(verifier)) return false;
  return safeEqual(sha256(verifier), challenge);
}
