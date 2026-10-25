import { type Database, clients, securityEvents } from "@kingdom-id/db";
import { desc, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type SecurityEventEnvelope, type SecurityEventInput, envelope } from "../security/pipeline/events.js";
import type { EventStream } from "../security/pipeline/stream.js";

export type { SecurityEventInput, SecurityEventType } from "../security/pipeline/events.js";

/**
 * Account activity. Producers call `record`, which only publishes to the
 * Redis Stream: the request never waits on Postgres or on detection rules.
 * The stream consumer persists events (`persistEvent`) and runs the rules.
 */
export class SecurityEventService {
  constructor(
    private readonly db: Database,
    private readonly stream: EventStream<SecurityEventEnvelope>,
    private readonly trustProxyHeaders: boolean,
  ) {}

  async record(req: FastifyRequest | undefined, event: SecurityEventInput): Promise<void> {
    await this.stream.publish(envelope(req, event, this.trustProxyHeaders));
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

/** Writes one event. Idempotent by event ID, because the stream delivers at least once. */
export async function persistEvent(db: Database, e: SecurityEventEnvelope): Promise<void> {
  await db
    .insert(securityEvents)
    .values({
      id: e.id,
      type: e.type,
      userId: e.userId ?? null,
      clientId: e.clientId ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      details: { ...e.details, ...(e.network ? { network: e.network } : {}), ...(e.country ? { country: e.country } : {}) },
      createdAt: new Date(e.at),
    })
    .onConflictDoNothing({ target: securityEvents.id });
}
