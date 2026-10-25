import { type Database, alerts, users } from "@kingdom-id/db";
import { and, desc, eq, isNull } from "drizzle-orm";

export class AlertService {
  constructor(private readonly db: Database) {}

  async list(filter: "open" | "all", limit = 100) {
    return this.db
      .select({ alert: alerts, email: users.email })
      .from(alerts)
      .leftJoin(users, eq(users.id, alerts.userId))
      .where(filter === "open" ? isNull(alerts.acknowledgedAt) : undefined)
      .orderBy(desc(alerts.createdAt))
      .limit(limit);
  }

  async forUser(userId: string, limit = 50) {
    return this.db.select().from(alerts).where(eq(alerts.userId, userId)).orderBy(desc(alerts.createdAt)).limit(limit);
  }

  async acknowledge(id: string, adminId: string): Promise<boolean> {
    const updated = await this.db
      .update(alerts)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: adminId })
      .where(and(eq(alerts.id, id), isNull(alerts.acknowledgedAt)))
      .returning({ id: alerts.id });
    return updated.length > 0;
  }
}
