import { type Database, type Mask, clients, masks, reverseAliases, users } from "@kingdom-id/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { isOnDomain, newMaskAddress, newReverseAlias, normalizeAddress } from "./addresses.js";
import {
  type Message,
  formatAddress,
  headerValue,
  parseFirstAddress,
  parseMessage,
  prependHeaders,
  removeHeaders,
  serializeMessage,
} from "./mime.js";
import type { RelayTransport } from "./transport.js";

/** What SES reports about an inbound message, reduced to what the relay decides on. */
export interface InboundMessage {
  /** SES message ID; used to make redelivery harmless. */
  id: string;
  raw: Buffer;
  /** Envelope recipients on our domain. */
  recipients: string[];
  verdicts: {
    spam?: Verdict;
    virus?: Verdict;
    spf?: Verdict;
    dkim?: Verdict;
    dmarc?: Verdict;
    dmarcPolicy?: string;
  };
}

export type Verdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "DISABLED";

export type Outcome =
  | "forwarded"
  | "replied"
  | "duplicate"
  | "dropped:unknown_recipient"
  | "dropped:mask_disabled"
  | "dropped:mask_deleted"
  | "dropped:unverified_owner"
  | "dropped:virus"
  | "dropped:spam"
  | "dropped:dmarc"
  | "dropped:loop"
  | "dropped:not_owner";

/** Headers that would break or leak once a message is re-sent from our domain. */
const STRIP_INBOUND = [
  "DKIM-Signature",
  "ARC-*",
  "Authentication-Results",
  "Received-SPF",
  "Return-Path",
  "Sender",
  "From",
  "Reply-To",
  "X-SES-*",
  // mailto: unsubscribe would be sent from the user's real address.
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
];
const STRIP_REPLY = [...STRIP_INBOUND, "To", "Cc", "Bcc", "Disposition-Notification-To", "Return-Receipt-To"];

export interface RelayOptions {
  domain: string;
  onSpoof?: (event: { userId: string; maskId: string; claimedFrom: string | undefined }) => Promise<void>;
}

export class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayError";
  }
}

export class RelayService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly transport: RelayTransport,
    private readonly options: RelayOptions,
  ) {}

  get domain() {
    return this.options.domain;
  }

  // ------------------------------------------------------------------
  // Masks
  // ------------------------------------------------------------------

  /** The live mask for this user and app, created on first use. */
  async ensureMask(userId: string, clientId: string): Promise<Mask> {
    const existing = await this.liveMask(userId, clientId);
    if (existing) return existing;
    for (let attempt = 0; attempt < 5; attempt++) {
      const [created] = await this.db
        .insert(masks)
        .values({ userId, clientId, address: newMaskAddress(this.options.domain) })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      // Either another request created this user's mask first, or (vanishingly
      // rarely) the random address collided. Re-read and retry.
      const raced = await this.liveMask(userId, clientId);
      if (raced) return raced;
    }
    throw new RelayError("could not allocate a relay address");
  }

  async listForUser(userId: string) {
    return this.db
      .select({ mask: masks, clientName: clients.name, clientLogo: clients.logoUri })
      .from(masks)
      .innerJoin(clients, eq(clients.id, masks.clientId))
      .where(and(eq(masks.userId, userId), ne(masks.status, "deleted")))
      .orderBy(desc(masks.createdAt));
  }

  async setForwarding(userId: string, maskId: string, on: boolean): Promise<Mask> {
    const [updated] = await this.db
      .update(masks)
      .set({ status: on ? "active" : "disabled" })
      .where(and(eq(masks.id, maskId), eq(masks.userId, userId), ne(masks.status, "deleted")))
      .returning();
    if (!updated) throw new RelayError("That address isn't on your account.");
    return updated;
  }

  /**
   * Retires an address for good: mail to it is dropped, and it's never
   * reissued. The app gets a fresh address the next time it reads `email`.
   */
  async remove(userId: string, maskId: string): Promise<Mask> {
    const [deleted] = await this.db
      .update(masks)
      .set({ status: "deleted" })
      .where(and(eq(masks.id, maskId), eq(masks.userId, userId), ne(masks.status, "deleted")))
      .returning();
    if (!deleted) throw new RelayError("That address isn't on your account.");
    return deleted;
  }

  // ------------------------------------------------------------------
  // Mail
  // ------------------------------------------------------------------

  /** Routes one inbound message to each of its recipients on our domain. */
  async handleInbound(inbound: InboundMessage): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    const message = parseMessage(inbound.raw);
    for (const recipient of new Set(inbound.recipients.map(normalizeAddress))) {
      if (!isOnDomain(recipient, this.options.domain)) continue;
      // SNS delivers at least once; process each (message, recipient) pair once.
      const fresh = await this.redis.set(`relay:seen:${inbound.id}:${recipient}`, "1", "EX", 7 * 24 * 3600, "NX");
      if (!fresh) {
        outcomes.set(recipient, "duplicate");
        continue;
      }
      outcomes.set(recipient, await this.route(recipient, message, inbound));
    }
    return outcomes;
  }

  private async route(recipient: string, message: Message, inbound: InboundMessage): Promise<Outcome> {
    if (inbound.verdicts.virus === "FAIL") return "dropped:virus";
    const sender = parseFirstAddress(headerValue(message, "From"));
    // Never relay our own relay mail back into the relay.
    if (sender && isOnDomain(sender.address, this.options.domain)) return "dropped:loop";

    const [mask] = await this.db.select().from(masks).where(eq(masks.address, recipient));
    if (mask) return this.forwardToOwner(mask, message, inbound, sender);

    const [alias] = await this.db
      .select({ alias: reverseAliases, mask: masks })
      .from(reverseAliases)
      .innerJoin(masks, eq(masks.id, reverseAliases.maskId))
      .where(eq(reverseAliases.address, recipient));
    if (alias) return this.forwardReply(alias.mask, alias.alias.id, alias.alias.correspondent, message, inbound, sender);

    return "dropped:unknown_recipient";
  }

  /** Outside sender → mask → the user's real inbox. */
  private async forwardToOwner(mask: Mask, message: Message, inbound: InboundMessage, sender: { name?: string; address: string } | undefined): Promise<Outcome> {
    if (mask.status === "deleted") return "dropped:mask_deleted";
    const blocked = (outcome: Outcome) => this.countBlocked(mask.id).then(() => outcome);
    if (mask.status === "disabled") return blocked("dropped:mask_disabled");
    if (inbound.verdicts.spam === "FAIL") return blocked("dropped:spam");
    if (inbound.verdicts.dmarc === "FAIL" && inbound.verdicts.dmarcPolicy?.toLowerCase() === "reject") return blocked("dropped:dmarc");

    const [owner] = await this.db.select().from(users).where(eq(users.id, mask.userId));
    // Forward only to an address the user has proven they own.
    if (!owner?.emailVerified) return blocked("dropped:unverified_owner");

    const from = sender?.address ?? "unknown@invalid";
    const alias = await this.reverseAliasFor(mask.id, from);
    const label = sender?.name ? `${sender.name} (${from})` : from;
    const rewritten = prependHeaders(removeHeaders(message, STRIP_INBOUND), [
      { name: "From", value: formatAddress(alias, `${label} via Kingdom`) },
      { name: "Reply-To", value: alias },
      { name: "X-Kingdom-Relay", value: `forwarded for ${mask.address}` },
      ...(headerValue(message, "From") ? [{ name: "X-Kingdom-Original-From", value: headerValue(message, "From")! }] : []),
    ]);
    await this.transport.send({ from: alias, to: owner.email, raw: serializeMessage(rewritten) });
    await this.db
      .update(masks)
      .set({ forwardedCount: sql`${masks.forwardedCount} + 1`, lastForwardedAt: sql`now()` })
      .where(eq(masks.id, mask.id));
    return "forwarded";
  }

  /** The user's reply → reverse alias → the outside correspondent, sent from the mask. */
  private async forwardReply(
    mask: Mask,
    aliasId: string,
    correspondent: string,
    message: Message,
    inbound: InboundMessage,
    sender: { address: string } | undefined,
  ): Promise<Outcome> {
    if (mask.status === "deleted") return "dropped:mask_deleted";
    const [owner] = await this.db.select().from(users).where(eq(users.id, mask.userId));
    // Only the mask's owner may speak through it, and only with mail that
    // authenticates as coming from them: otherwise the relay is a spoofing tool.
    const authenticated =
      (inbound.verdicts.spf === "PASS" || inbound.verdicts.dkim === "PASS") && inbound.verdicts.dmarc !== "FAIL";
    if (!owner || !sender || sender.address !== normalizeAddress(owner.email) || !authenticated) {
      await this.options.onSpoof?.({ userId: mask.userId, maskId: mask.id, claimedFrom: sender?.address });
      return "dropped:not_owner";
    }
    const rewritten = prependHeaders(removeHeaders(message, STRIP_REPLY), [
      { name: "From", value: mask.address },
      { name: "To", value: correspondent },
    ]);
    await this.transport.send({ from: mask.address, to: correspondent, raw: serializeMessage(rewritten) });
    await this.db.update(reverseAliases).set({ lastUsedAt: sql`now()` }).where(eq(reverseAliases.id, aliasId));
    return "replied";
  }

  private async reverseAliasFor(maskId: string, correspondent: string): Promise<string> {
    const who = normalizeAddress(correspondent);
    const find = async () =>
      (await this.db
        .select({ address: reverseAliases.address })
        .from(reverseAliases)
        .where(and(eq(reverseAliases.maskId, maskId), eq(reverseAliases.correspondent, who))))[0]?.address;
    const existing = await find();
    if (existing) return existing;
    await this.db
      .insert(reverseAliases)
      .values({ maskId, correspondent: who, address: newReverseAlias(this.options.domain) })
      .onConflictDoNothing();
    return (await find())!;
  }

  private async countBlocked(maskId: string) {
    await this.db.update(masks).set({ blockedCount: sql`${masks.blockedCount} + 1` }).where(eq(masks.id, maskId));
  }

  private async liveMask(userId: string, clientId: string) {
    const [mask] = await this.db
      .select()
      .from(masks)
      .where(and(eq(masks.userId, userId), eq(masks.clientId, clientId), ne(masks.status, "deleted")));
    return mask;
  }
}
