import type { CookieSerializeOptions } from "@fastify/cookie";

/**
 * `__Host-` cookies must be Secure, Path=/ and have no Domain, so the browser
 * guarantees they were set by this exact origin over a secure channel.
 */
export function cookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

export function cookieOptions(secure: boolean, maxAgeSeconds?: number): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure,
    // Lax, not Strict: the authorization request arrives as a top-level
    // cross-site GET from the relying party and must carry the session.
    sameSite: "lax",
    path: "/",
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}
