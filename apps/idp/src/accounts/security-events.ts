import { type Database, clients, securityEvents } from "@kingdom-id/db";
import { desc, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

export type SecurityEventType =
  | "sign_in"
  | "sign_in_failed"
  | "signed_out"
  | "account_created"
  | "email_verified"
  | "passkey_added"
  | "passkey_removed"
  | "app_connected"
  | "app_disconnected"
  | "refresh_token_reuse"
  | "code_replay";

export interface SecurityEventInput {
  type: SecurityEventType;
  userId?: string | undefined;
  clientId?: string | undefined;
  details?: Record<string, unknown>;
}

/** Account activity for Watchtower. Phase 7 puts a Redis Stream and detection rules in front of this. */
export class SecurityEventService {
  constructor(private readonly db: Database) {}

  async record(req: FastifyRequest | undefined, event: SecurityEventInput): Promise<void> {
    await this.db.insert(securityEvents).values({
      type: event.type,
      userId: event.userId ?? null,
      clientId: event.clientId ?? null,
      ip: req?.ip ?? null,
      userAgent: req?.headers["user-agent"]?.slice(0, 512) ?? null,
      details: event.details ?? {},
    });
  }

  async listForUser(userId: string, limit = 50) {
    return this.db
      .select({ event: securityEvents, clientName: clients.name })
      .from(securityEvents)
      .leftJoin(clients, eq(clients.id, securityEvents.clientId))
      .where(eq(securityEvents.userId, userId))
      .orderBy(desc(securityEvents.createdAt))
      .limit(limit);
  }
}
