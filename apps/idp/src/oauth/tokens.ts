import { createHash } from "node:crypto";
import type { Client, Grant } from "@kingdom-id/db";
import { SignJWT } from "jose";
import type { KeyStore } from "../keys/keystore.js";
import { randomToken } from "../lib/crypto.js";
import { sessionIdFor } from "./subject.js";

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
}

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  scope: string;
  jti: string;
  /** The grant this token was minted from; revoking the grant revokes the token. */
  gid: string;
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

export interface IssueOptions {
  /** Scopes for this access token: the grant's, or a subset on refresh. */
  scopes: string[];
  nonce?: string;
  refreshToken?: string;
}

export class TokenService {
  constructor(
    private readonly keys: KeyStore,
    private readonly options: TokenServiceOptions,
  ) {}

  async issue(client: Client, grant: Grant, opts: IssueOptions): Promise<TokenResponse> {
    const { issuer, accessTokenTtl, idTokenTtl, serverSecret } = this.options;
    const now = Math.floor(Date.now() / 1000);
    const scope = opts.scopes.join(" ");
    const authTime = Math.floor(grant.authTime.getTime() / 1000);

    // RFC 9068 JWT access token. Always RS256, which every RFC 9068 resource
    // server must support, independent of the client's ID token alg.
    const atKey = await this.keys.getActiveKey("RS256");
    const accessToken = await new SignJWT({ client_id: client.id, scope, gid: grant.id, auth_time: authTime })
      .setProtectedHeader({ alg: "RS256", kid: atKey.kid, typ: "at+jwt" })
      .setIssuer(issuer)
      .setSubject(grant.subject)
      .setAudience(issuer)
      .setJti(randomToken(16))
      .setIssuedAt(now)
      .setExpirationTime(now + accessTokenTtl)
      .sign(atKey.key);

    const response: TokenResponse = { access_token: accessToken, token_type: "Bearer", expires_in: accessTokenTtl, scope };
    if (opts.refreshToken) response.refresh_token = opts.refreshToken;

    if (opts.scopes.includes("openid")) {
      const idKey = await this.keys.getActiveKey(client.idTokenSignedResponseAlg);
      // Profile and email claims are deliberately left out: in the code flow
      // they're released through UserInfo, against the access token (OIDC
      // Core §5.4). An ID token is proof of authentication that relying
      // parties pass around, so it shouldn't carry personal data by default.
      response.id_token = await new SignJWT({
        // On refresh this stays the original authentication time (OIDC Core §12.2).
        auth_time: authTime,
        amr: grant.amr,
        at_hash: leftHalfHash(accessToken),
        // The session may be gone by the time an offline grant refreshes.
        ...(grant.sessionId ? { sid: sessionIdFor(serverSecret, client.id, grant.sessionId) } : {}),
        ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
      })
        .setProtectedHeader({ alg: idKey.alg, kid: idKey.kid, typ: "JWT" })
        .setIssuer(issuer)
        .setSubject(grant.subject)
        .setAudience(client.id)
        .setIssuedAt(now)
        .setExpirationTime(now + idTokenTtl)
        .sign(idKey.key);
    }
    return response;
  }
}

/** at_hash (OIDC Core §3.1.3.6): left half of SHA-256, which both RS256 and ES256 use. */
export function leftHalfHash(token: string): string {
  const digest = createHash("sha256").update(token, "ascii").digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}
