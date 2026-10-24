import { type Database, type Grant, grants, refreshTokens } from "@kingdom-id/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { randomToken, sha256 } from "../lib/crypto.js";
import type { CodeGrant } from "./codes.js";

// A recognizable prefix lets secret scanners (GitHub, gitleaks) spot leaked
// refresh tokens. Access tokens are JWTs and already recognizable.
const REFRESH_PREFIX = "krt_";

export const isRefreshTokenShaped = (token: string) =>
  token.startsWith(REFRESH_PREFIX) && token.length === REFRESH_PREFIX.length + 43;

export type Rotation =
  | { status: "ok"; grant: Grant; refreshToken: string }
  | { status: "reused"; grant: Grant }
  | { status: "invalid" };

export type RevocationReason =
  | "refresh_token_reuse"
  | "code_replay"
  | "revoked_by_client"
  | "logout"
  | "disconnected_by_user";

export interface GrantServiceOptions {
  accessTokenTtl: number;
  refreshIdleTtl: number;
  refreshAbsoluteTtl: number;
}

export class GrantService {
  constructor(
    private readonly db: Database,
    private readonly options: GrantServiceOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records the grant behind a successful code exchange. */
  async create(code: CodeGrant, codeHash: string): Promise<Grant> {
    const offline = code.scopes.includes("offline_access");
    const now = this.now();
    // An online grant only ever backs access tokens, so it needs to live no
    // longer than they do. An offline grant is bounded by the absolute
    // refresh token lifetime: rotation can't extend a family forever.
    const ttl = offline ? this.options.refreshAbsoluteTtl : this.options.accessTokenTtl;
    const [grant] = await this.db
      .insert(grants)
      .values({
        id: randomToken(16),
        userId: code.userId,
        clientId: code.clientId,
        sessionId: code.sessionId,
        subject: code.sub,
        scopes: code.scopes,
        authTime: new Date(code.authTime * 1000),
        amr: code.amr,
        codeHash,
        offline,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttl * 1000),
      })
      .returning();
    return grant!;
  }

  async find(id: string): Promise<Grant | undefined> {
    const [grant] = await this.db.select().from(grants).where(eq(grants.id, id));
    return grant;
  }

  isActive(grant: Grant): boolean {
    return !grant.revokedAt && grant.expiresAt > this.now();
  }

  async issueRefreshToken(grant: Grant): Promise<string> {
    const token = REFRESH_PREFIX + randomToken();
    const now = this.now();
    const idleExpiry = now.getTime() + this.options.refreshIdleTtl * 1000;
    await this.db.insert(refreshTokens).values({
      grantId: grant.id,
      tokenHash: sha256(token),
      createdAt: now,
      expiresAt: new Date(Math.min(idleExpiry, grant.expiresAt.getTime())),
    });
    return token;
  }

  /**
   * Exchanges a refresh token for a new one (RFC 9700 §4.14.2). A token can be
   * exchanged once; presenting a spent token means it was copied, so the whole
   * family (the grant and everything minted from it) is revoked.
   */
  async rotate(token: string, clientId: string): Promise<Rotation> {
    if (!isRefreshTokenShaped(token)) return { status: "invalid" };
    const found = await this.lookup(token);
    // Another client's token: refuse without touching it, so a client can't
    // burn someone else's family by presenting a stolen token.
    if (!found || found.grant.clientId !== clientId) return { status: "invalid" };
    const { refreshToken, grant } = found;

    if (refreshToken.usedAt) return this.reuseDetected(grant);
    const now = this.now();
    if (!this.isActive(grant) || refreshToken.expiresAt <= now) return { status: "invalid" };

    // Conditional update: of two concurrent exchanges, exactly one wins. The
    // loser looks like reuse, which it is from our side of the wire.
    const spent = await this.db
      .update(refreshTokens)
      .set({ usedAt: now })
      .where(and(eq(refreshTokens.id, refreshToken.id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    if (spent.length === 0) return this.reuseDetected(grant);

    return { status: "ok", grant, refreshToken: await this.issueRefreshToken(grant) };
  }

  /** Finds a refresh token and its grant, whatever their state. */
  async lookup(token: string) {
    if (!isRefreshTokenShaped(token)) return undefined;
    const [row] = await this.db
      .select({ refreshToken: refreshTokens, grant: grants })
      .from(refreshTokens)
      .innerJoin(grants, eq(grants.id, refreshTokens.grantId))
      .where(eq(refreshTokens.tokenHash, sha256(token)));
    return row;
  }

  async revoke(id: string, reason: RevocationReason): Promise<void> {
    await this.db
      .update(grants)
      .set({ revokedAt: this.now(), revokedReason: reason })
      .where(and(eq(grants.id, id), isNull(grants.revokedAt)));
  }

  /** Revokes whatever a replayed authorization code produced the first time. */
  async revokeByCodeHash(codeHash: string): Promise<Grant | undefined> {
    const [grant] = await this.db
      .update(grants)
      .set({ revokedAt: this.now(), revokedReason: "code_replay" })
      .where(and(eq(grants.codeHash, codeHash), isNull(grants.revokedAt)))
      .returning();
    return grant;
  }

  /**
   * Ends the online grants tied to a browser session. Offline grants are
   * exactly the ones the user asked to outlive the session (OIDC Core §11),
   * so they survive logout.
   */
  async revokeOnlineForSession(sessionId: string): Promise<void> {
    await this.db
      .update(grants)
      .set({ revokedAt: this.now(), revokedReason: "logout" })
      .where(
        and(eq(grants.sessionId, sessionId), eq(grants.offline, false), isNull(grants.revokedAt), gt(grants.expiresAt, this.now())),
      );
  }

  private async reuseDetected(grant: Grant): Promise<Rotation> {
    await this.revoke(grant.id, "refresh_token_reuse");
    return { status: "reused", grant };
  }
}
