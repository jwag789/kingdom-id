import type { Grant } from "@kingdom-id/db";
import type { JWTPayload } from "jose";
import type { Redis } from "ioredis";
import type { KeyStore } from "../keys/keystore.js";
import type { GrantService } from "./grants.js";
import type { AccessTokenClaims } from "./tokens.js";

/**
 * Validates our own access tokens for userinfo and introspection. A JWT that
 * verifies is not enough: its grant must still be live (not revoked by reuse
 * detection, logout or the user) and its own jti must not be revoked.
 */
export class AccessTokenVerifier {
  constructor(
    private readonly keys: KeyStore,
    private readonly grants: GrantService,
    private readonly redis: Redis,
    private readonly issuer: string,
  ) {}

  async verify(token: string): Promise<{ claims: AccessTokenClaims; grant: Grant } | undefined> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.keys.verify<AccessTokenClaims & JWTPayload>(token, {
        issuer: this.issuer,
        audience: this.issuer,
        typ: "at+jwt",
        algorithms: ["RS256"],
        requiredClaims: ["sub", "client_id", "scope", "exp", "jti", "gid"],
      });
    } catch {
      return undefined;
    }
    if (await this.redis.exists(revokedKey(claims.jti))) return undefined;
    const grant = await this.grants.find(claims.gid);
    if (!grant || grant.revokedAt || grant.clientId !== claims.client_id) return undefined;
    return { claims, grant };
  }

  /** Revokes one access token (RFC 7009) until it would have expired anyway. */
  async revoke(claims: AccessTokenClaims): Promise<void> {
    const ttl = claims.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await this.redis.set(revokedKey(claims.jti), "1", "EX", ttl);
  }
}

const revokedKey = (jti: string) => `revoked-at:${jti}`;
