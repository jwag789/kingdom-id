import type { FastifyReply, FastifyRequest } from "fastify";
import { hmac, randomToken, safeEqual } from "../lib/crypto.js";
import { cookieName, cookieOptions } from "./cookies.js";

export class CsrfError extends Error {
  constructor() {
    super("CSRF validation failed");
    this.name = "CsrfError";
  }
}

/**
 * Signed double-submit tokens. A random per-browser value lives in an
 * HttpOnly cookie; forms carry HMAC(secret, value). An attacker on another
 * origin can neither read the cookie nor forge the HMAC, and the cookie value
 * also binds authorization interactions to the browser that started them.
 */
export class Csrf {
  readonly cookie: string;

  constructor(
    private readonly secret: Buffer,
    private readonly secure: boolean,
  ) {
    this.cookie = cookieName("kid_csrf", secure);
  }

  /** Returns the browser's CSRF cookie value, setting one if absent. */
  browserId(req: FastifyRequest, reply: FastifyReply): string {
    let value = req.cookies[this.cookie];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
      value = randomToken();
      reply.setCookie(this.cookie, value, cookieOptions(this.secure));
      // Make it visible to the rest of this request too.
      req.cookies[this.cookie] = value;
    }
    return value;
  }

  token(req: FastifyRequest, reply: FastifyReply): string {
    return hmac(this.secret, `csrf:${this.browserId(req, reply)}`);
  }

  verify(req: FastifyRequest): void {
    // Fetch metadata is a cheap first gate where browsers send it.
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw new CsrfError();
    const value = req.cookies[this.cookie];
    const submitted = (req.body as Record<string, unknown> | undefined)?.csrf;
    if (!value || typeof submitted !== "string") throw new CsrfError();
    if (!safeEqual(submitted, hmac(this.secret, `csrf:${value}`))) throw new CsrfError();
  }
}
