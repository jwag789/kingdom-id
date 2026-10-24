import { createHash } from "node:crypto";
import type { Client, User } from "@kingdom-id/db";
import { SignJWT } from "jose";
import type { KeyStore } from "../keys/keystore.js";
import { randomToken } from "../lib/crypto.js";
import type { CodeGrant } from "./codes.js";
import { userClaims } from "./scopes.js";
import { sessionIdFor } from "./subject.js";

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  id_token: string;
  scope: string;
}

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  scope: string;
  jti: string;
  iat: number;
  exp: number;
  auth_time: number;
}

export interface TokenServiceOptions {
  issuer: string;
  serverSecret: Buffer;
  accessTokenTtl: number;
  idTokenTtl: number;
}

export class TokenService {
  constructor(
    private readonly keys: KeyStore,
    private readonly options: TokenServiceOptions,
  ) {}

  async issue(client: Client, user: User, grant: CodeGrant): Promise<TokenResponse> {
    const { issuer, accessTokenTtl, idTokenTtl, serverSecret } = this.options;
    const now = Math.floor(Date.now() / 1000);
    const scope = grant.scopes.join(" ");

    // RFC 9068 JWT access token. Always RS256, which every RFC 9068 resource
    // server must support, independent of the client's ID token alg.
    const atKey = await this.keys.getActiveKey("RS256");
    const accessToken = await new SignJWT({ client_id: client.id, scope, auth_time: grant.authTime })
      .setProtectedHeader({ alg: "RS256", kid: atKey.kid, typ: "at+jwt" })
      .setIssuer(issuer)
      .setSubject(grant.sub)
      .setAudience(issuer)
      .setJti(randomToken(16))
      .setIssuedAt(now)
      .setExpirationTime(now + accessTokenTtl)
      .sign(atKey.key);

    const idKey = await this.keys.getActiveKey(client.idTokenSignedResponseAlg);
    const idToken = await new SignJWT({
      ...userClaims(user, grant.scopes),
      auth_time: grant.authTime,
      amr: grant.amr,
      sid: sessionIdFor(serverSecret, client.id, grant.sessionId),
      at_hash: leftHalfHash(accessToken),
      ...(grant.nonce !== undefined ? { nonce: grant.nonce } : {}),
    })
      .setProtectedHeader({ alg: idKey.alg, kid: idKey.kid, typ: "JWT" })
      .setIssuer(issuer)
      .setSubject(grant.sub)
      .setAudience(client.id)
      .setIssuedAt(now)
      .setExpirationTime(now + idTokenTtl)
      .sign(idKey.key);

    return { access_token: accessToken, token_type: "Bearer", expires_in: accessTokenTtl, id_token: idToken, scope };
  }
}

/** at_hash (OIDC Core §3.1.3.6): left half of SHA-256, which both RS256 and ES256 use. */
export function leftHalfHash(token: string): string {
  const digest = createHash("sha256").update(token, "ascii").digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}
