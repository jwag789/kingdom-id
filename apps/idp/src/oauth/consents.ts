import { type Client, type Consent, type Database, type User, clients, consents, users } from "@kingdom-id/db";
import { and, desc, eq, sql } from "drizzle-orm";

export class ConsentService {
  constructor(private readonly db: Database) {}

  async get(userId: string, clientId: string): Promise<Consent | undefined> {
    const [row] = await this.db
      .select()
      .from(consents)
      .where(and(eq(consents.userId, userId), eq(consents.clientId, clientId)));
    return row;
  }

  /** Records consent, widening any earlier grant to the union of both scope sets. */
  async grant(userId: string, clientId: string, subject: string, scopes: string[]): Promise<void> {
    await this.db
      .insert(consents)
      .values({ userId, clientId, subject, scopes })
      .onConflictDoUpdate({
        target: [consents.userId, consents.clientId],
        set: {
          scopes: sql`(select array_agg(distinct s) from unnest(${consents.scopes} || excluded.scopes) as s)`,
          updatedAt: new Date(),
        },
      });
  }

  /** The user's connected apps ("realms"), most recently used first. */
  async listForUser(userId: string): Promise<{ consent: Consent; client: Client }[]> {
    return this.db
      .select({ consent: consents, client: clients })
      .from(consents)
      .innerJoin(clients, eq(clients.id, consents.clientId))
      .where(eq(consents.userId, userId))
      .orderBy(desc(sql`coalesce(${consents.lastUsedAt}, ${consents.createdAt})`));
  }

  async touch(userId: string, clientId: string): Promise<void> {
    await this.db
      .update(consents)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(consents.userId, userId), eq(consents.clientId, clientId)));
  }

  /** Forgets the consent. Returns whether there was one. Callers also revoke the app's grants. */
  async remove(userId: string, clientId: string): Promise<boolean> {
    const removed = await this.db
      .delete(consents)
      .where(and(eq(consents.userId, userId), eq(consents.clientId, clientId)))
      .returning({ clientId: consents.clientId });
    return removed.length > 0;
  }

  /** Resolves the `sub` a client knows back to a user, if the user still has the app connected. */
  async userForSubject(clientId: string, subject: string): Promise<User | undefined> {
    const [row] = await this.db
      .select({ user: users })
      .from(consents)
      .innerJoin(users, eq(users.id, consents.userId))
      .where(and(eq(consents.clientId, clientId), eq(consents.subject, subject)));
    return row?.user;
  }
}

export const covers = (consent: Consent | undefined, scopes: readonly string[]) =>
  !!consent && scopes.every((s) => consent.scopes.includes(s));
