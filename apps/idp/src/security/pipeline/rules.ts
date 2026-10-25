import { type Database, alerts, securityEvents } from "@kingdom-id/db";
import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { SecurityEventEnvelope } from "./events.js";

type Severity = "low" | "medium" | "high" | "critical";

interface NewAlert {
  rule: string;
  severity: Severity;
  summary: string;
  /** What this alert is about, for de-duplication within `dedupeSeconds`. */
  subject: string;
  dedupeSeconds: number;
  userId?: string;
  ip?: string;
  clientId?: string;
  details?: Record<string, unknown>;
}

export const RULES = {
  // Five wrong passwords for one account in ten minutes.
  accountBurst: { threshold: 5, windowMinutes: 10 },
  // Twenty failures from one IP in ten minutes, whichever accounts they target.
  ipBurst: { threshold: 20, windowMinutes: 10 },
  // How far back "places you've signed in from before" reaches.
  locationHistoryDays: 180,
} as const;

/**
 * Detection rules, run by the stream consumer after each event is
 * persisted. Each returns at most one alert per event; alerts are
 * de-duplicated per rule and subject, so a burst raises one alert, not fifty.
 */
export class DetectionRules {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
  ) {}

  async evaluate(event: SecurityEventEnvelope): Promise<void> {
    const found = await Promise.all([this.failedLoginBurst(event), this.tokenAbuse(event), this.newLocation(event)]);
    for (const alert of found.flat()) await this.raise(alert, event);
  }

  private async failedLoginBurst(e: SecurityEventEnvelope): Promise<NewAlert[]> {
    if (e.type !== "sign_in_failed") return [];
    const out: NewAlert[] = [];
    const since = (minutes: number) => new Date(new Date(e.at).getTime() - minutes * 60_000);

    if (e.userId) {
      const [row] = await this.db
        .select({ n: count() })
        .from(securityEvents)
        .where(and(eq(securityEvents.type, "sign_in_failed"), eq(securityEvents.userId, e.userId), gte(securityEvents.createdAt, since(RULES.accountBurst.windowMinutes))));
      if ((row?.n ?? 0) >= RULES.accountBurst.threshold) {
        out.push({
          rule: "failed_login_burst",
          severity: "high",
          summary: `${row!.n} failed sign-in attempts on this account in ${RULES.accountBurst.windowMinutes} minutes`,
          subject: `user:${e.userId}`,
          dedupeSeconds: RULES.accountBurst.windowMinutes * 60,
          userId: e.userId,
          ...(e.ip ? { ip: e.ip } : {}),
          details: { attempts: row!.n },
        });
      }
    }
    if (e.ip) {
      const [row] = await this.db
        .select({ n: count(), accounts: sql<number>`count(distinct ${securityEvents.userId})` })
        .from(securityEvents)
        .where(and(eq(securityEvents.type, "sign_in_failed"), eq(securityEvents.ip, e.ip), gte(securityEvents.createdAt, since(RULES.ipBurst.windowMinutes))));
      if ((row?.n ?? 0) >= RULES.ipBurst.threshold) {
        out.push({
          rule: "credential_stuffing",
          severity: "critical",
          summary: `${row!.n} failed sign-ins from ${e.ip} across ${row!.accounts} known accounts in ${RULES.ipBurst.windowMinutes} minutes`,
          subject: `ip:${e.ip}`,
          dedupeSeconds: RULES.ipBurst.windowMinutes * 60,
          ip: e.ip,
          details: { attempts: row!.n, accounts: Number(row!.accounts) },
        });
      }
    }
    return out;
  }

  private async tokenAbuse(e: SecurityEventEnvelope): Promise<NewAlert[]> {
    const base = { subject: `event:${e.id}`, dedupeSeconds: 60, ...(e.userId ? { userId: e.userId } : {}), ...(e.clientId ? { clientId: e.clientId } : {}), ...(e.ip ? { ip: e.ip } : {}) };
    switch (e.type) {
      case "refresh_token_reuse":
        return [{ ...base, rule: "refresh_token_reuse", severity: "critical", summary: "A spent refresh token was presented again; its whole family was revoked" }];
      case "code_replay":
        return [{ ...base, rule: "code_replay", severity: "high", summary: "An authorization code was redeemed twice; the tokens from it were revoked" }];
      case "relay_spoof_blocked":
        return [{ ...base, rule: "relay_spoof", severity: "medium", summary: "Mail impersonating a member tried to leave through their private address" }];
      default:
        return [];
    }
  }

  /**
   * A successful sign-in from a country, or failing that a network, this
   * account hasn't signed in from in the last 180 days. A brand-new account
   * has no history, so its first sign-ins never alert.
   */
  private async newLocation(e: SecurityEventEnvelope): Promise<NewAlert[]> {
    if (e.type !== "sign_in" || !e.userId || !e.network) return [];
    const history = await this.db
      .select({ network: sql<string | null>`${securityEvents.details}->>'network'`, country: sql<string | null>`${securityEvents.details}->>'country'` })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.userId, e.userId),
          sql`${securityEvents.type} in ('sign_in', 'account_created')`,
          ne(securityEvents.id, e.id),
          gte(securityEvents.createdAt, new Date(new Date(e.at).getTime() - RULES.locationHistoryDays * 86_400_000)),
        ),
      );
    if (history.length === 0) return [];
    const base = { userId: e.userId, ip: e.ip!, dedupeSeconds: 24 * 3600 };
    if (e.country && history.some((h) => h.country) && !history.some((h) => h.country === e.country)) {
      return [{ ...base, rule: "new_country", severity: "medium", subject: `user:${e.userId}:country:${e.country}`, summary: `Sign-in from a new country (${e.country})`, details: { country: e.country, network: e.network } }];
    }
    if (!history.some((h) => h.network === e.network)) {
      return [{ ...base, rule: "new_network", severity: "low", subject: `user:${e.userId}:network:${e.network}`, summary: `Sign-in from a new network (${e.network})`, details: { network: e.network } }];
    }
    return [];
  }

  private async raise(alert: NewAlert, event: SecurityEventEnvelope) {
    // SET NX: the first event over the threshold raises the alert; the rest of the burst doesn't.
    const first = await this.redis.set(`alert:dedupe:${alert.rule}:${alert.subject}`, event.id, "EX", alert.dedupeSeconds, "NX");
    if (!first) return;
    await this.db.insert(alerts).values({
      rule: alert.rule,
      severity: alert.severity,
      summary: alert.summary,
      userId: alert.userId ?? null,
      ip: alert.ip ?? null,
      clientId: alert.clientId ?? null,
      details: alert.details ?? {},
      eventId: event.id,
    });
  }
}
