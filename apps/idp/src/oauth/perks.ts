import { type Client, type Database, type Perk, clients, consents, perkGrants, perks, users } from "@kingdom-id/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

const DAY_MS = 24 * 60 * 60 * 1000;

export const perkInput = z
  .object({
    clientId: z.string().min(1),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "Lowercase letters, digits, dots and dashes, like cappuccino.early-supporter")
      .max(80),
    name: z.string().trim().min(1, "Give the perk a name").max(80),
    description: z.string().trim().min(1, "Describe what the perk gives").max(240),
    rule: z.enum(["connected", "connected_days", "connected_apps", "manual"]),
    threshold: z.coerce.number().int().positive().max(10_000).optional(),
  })
  .refine((p) => p.rule === "connected" || p.rule === "manual" || p.threshold !== undefined, {
    message: "This rule needs a number",
    path: ["threshold"],
  });

export type PerkInput = z.infer<typeof perkInput>;

export interface UnlockedPerk {
  perk: Perk;
  appName: string;
}

/** The `perks` claim: what apps see. Stable ids, human names, and which app offers each. */
export interface PerkClaim {
  id: string;
  name: string;
  app: string;
}

export class PerkService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listWithClients(): Promise<{ perk: Perk; client: Client }[]> {
    return this.db
      .select({ perk: perks, client: clients })
      .from(perks)
      .innerJoin(clients, eq(clients.id, perks.clientId))
      .orderBy(clients.name, perks.name);
  }

  async create(input: PerkInput): Promise<Perk> {
    const [perk] = await this.db
      .insert(perks)
      .values({
        ...input,
        threshold: input.rule === "connected" || input.rule === "manual" ? null : (input.threshold ?? null),
      })
      .onConflictDoNothing({ target: perks.slug })
      .returning();
    if (!perk) throw new PerkError("A perk with that id already exists.");
    return perk;
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.db.update(perks).set({ active }).where(eq(perks.id, id));
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(perks).where(eq(perks.id, id));
  }

  /** Grants a manual perk to the account with this email. */
  async grant(perkId: string, email: string): Promise<void> {
    const [perk] = await this.db.select().from(perks).where(eq(perks.id, perkId));
    if (!perk || perk.rule !== "manual") throw new PerkError("Only manual perks can be granted by hand.");
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase()));
    if (!user) throw new PerkError("No Kingdom account has that email.");
    await this.db.insert(perkGrants).values({ perkId, userId: user.id }).onConflictDoNothing();
  }

  /** Every active perk this user has unlocked, evaluated now. */
  async unlockedFor(userId: string): Promise<UnlockedPerk[]> {
    const [all, connections, manual] = await Promise.all([
      this.listWithClients(),
      this.db.select({ clientId: consents.clientId, since: consents.createdAt }).from(consents).where(eq(consents.userId, userId)),
      this.db.select({ perkId: perkGrants.perkId }).from(perkGrants).where(eq(perkGrants.userId, userId)),
    ]);
    const connectedSince = new Map(connections.map((c) => [c.clientId, c.since]));
    const granted = new Set(manual.map((m) => m.perkId));
    const now = this.now().getTime();

    const unlocked = ({ perk }: { perk: Perk }) => {
      switch (perk.rule) {
        case "connected":
          return connectedSince.has(perk.clientId);
        case "connected_days": {
          const since = connectedSince.get(perk.clientId);
          return !!since && now - since.getTime() >= (perk.threshold ?? 0) * DAY_MS;
        }
        case "connected_apps":
          return connectedSince.size >= (perk.threshold ?? Infinity);
        case "manual":
          return granted.has(perk.id);
      }
    };
    return all.filter((row) => row.perk.active && unlocked(row)).map(({ perk, client }) => ({ perk, appName: client.name }));
  }

  async claimFor(userId: string): Promise<PerkClaim[]> {
    return (await this.unlockedFor(userId)).map(({ perk, appName }) => ({ id: perk.slug, name: perk.name, app: appName }));
  }

  /** Perks the user could still unlock, for the Treasury's "within reach" list. */
  async lockedFor(userId: string): Promise<UnlockedPerk[]> {
    const unlocked = new Set((await this.unlockedFor(userId)).map((u) => u.perk.id));
    return (await this.listWithClients())
      .filter(({ perk }) => perk.active && perk.rule !== "manual" && !unlocked.has(perk.id))
      .map(({ perk, client }) => ({ perk, appName: client.name }));
  }

  async findManualGrant(perkId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(perkGrants)
      .where(and(eq(perkGrants.perkId, perkId), eq(perkGrants.userId, userId)));
    return row;
  }
}

export class PerkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerkError";
  }
}
