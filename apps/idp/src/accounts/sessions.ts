import { type Database, type Session, type User, sessions, users } from "@kingdom-id/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { randomToken, sha256 } from "../lib/crypto.js";

export interface ActiveSession {
  session: Session;
  user: User;
}

// lastSeenAt is a hint for the dashboard, not a security control, so it's
// written at most this often instead of on every request.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly ttlSeconds: number,
  ) {}

  /** Creates a session and returns the cookie value. Only its hash is stored. */
  async create(params: { userId: string; amr: string[]; ip?: string; userAgent?: string }) {
    const token = randomToken();
    const now = new Date();
    const [session] = await this.db
      .insert(sessions)
      .values({
        tokenHash: sha256(token),
        userId: params.userId,
        authTime: now,
        amr: params.amr,
        ip: params.ip ?? null,
        userAgent: params.userAgent?.slice(0, 512) ?? null,
        expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
      })
      .returning();
    return { token, session: session! };
  }

  async resolve(token: string | undefined): Promise<ActiveSession | undefined> {
    if (!token || token.length > 64) return undefined;
    const now = new Date();
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));
    if (!row) return undefined;
    if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
    }
    return row;
  }

  async revoke(id: string): Promise<void> {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
  }
}
