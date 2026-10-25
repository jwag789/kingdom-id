import { hostname } from "node:os";
import type { Redis } from "ioredis";

const GROUP = "persist-and-detect";
const BATCH = 50;
const BLOCK_MS = 5000;
// An entry a consumer read but never acknowledged for this long is assumed
// abandoned (the consumer crashed) and is claimed by another.
const RECLAIM_IDLE_MS = 30_000;
const MAX_ATTEMPTS = 5;

export type EventHandler<T> = (event: T) => Promise<void>;

interface Logger {
  error: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * Durable work on a Redis Stream with one consumer group: security events,
 * and back-channel logout deliveries. Every API
 * instance publishes; every instance also runs a consumer, and the group
 * hands each entry to exactly one of them. Delivery is at-least-once, so the
 * handler must be idempotent (it is: events persist by ID).
 */
export class EventStream<T extends { id: string }> {
  private running = false;
  private reader: Redis | undefined;
  private loop: Promise<void> | undefined;
  readonly consumer = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;

  constructor(
    private readonly redis: Redis,
    readonly key: string,
    private readonly maxLength: number,
    private readonly handle: EventHandler<T>,
    private readonly log: Logger,
  ) {}

  get deadLetterKey() {
    return `${this.key}:dead`;
  }

  async publish(event: T): Promise<void> {
    // Approximate trimming keeps XADD O(1); the stream is a buffer, Postgres is the record.
    await this.redis.xadd(this.key, "MAXLEN", "~", this.maxLength, "*", "e", JSON.stringify(event));
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", this.key, GROUP, "0", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
  }

  /** Starts this instance's consumer. Blocking reads use their own connection. */
  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    this.reader = this.redis.duplicate();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.reader?.disconnect();
    await this.loop?.catch(() => {});
  }

  /**
   * Processes everything currently on the stream, including entries other
   * consumers abandoned, and returns when the group is fully caught up. For
   * tests and orderly shutdown.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    await this.ensureGroup();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.reclaim(0);
      const fresh = await this.read(this.redis, 0);
      const [group] = (await this.redis.xinfo("GROUPS", this.key)) as unknown[][];
      const info = toObject(group ?? []);
      if (fresh === 0 && Number(info.pending) === 0 && Number(info.lag ?? 0) === 0) return;
      if (Date.now() > deadline) throw new Error(`event stream did not drain within ${timeoutMs}ms`);
    }
  }

  /** Lag, pending and dead-letter counts, for the admin view. */
  async health() {
    await this.ensureGroup();
    const [group] = (await this.redis.xinfo("GROUPS", this.key)) as unknown[][];
    const info = toObject(group ?? []);
    return {
      length: await this.redis.xlen(this.key),
      pending: Number(info.pending ?? 0),
      lag: Number(info.lag ?? 0),
      deadLetters: await this.redis.xlen(this.deadLetterKey),
    };
  }

  private async run() {
    while (this.running) {
      try {
        await this.reclaim(RECLAIM_IDLE_MS);
        await this.read(this.reader!, BLOCK_MS);
      } catch (err) {
        if (!this.running) return;
        this.log.error({ err }, "security event consumer error");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Reads new entries for this consumer; returns how many it processed. */
  private async read(connection: Redis, blockMs: number): Promise<number> {
    const args: (string | number)[] = ["GROUP", GROUP, this.consumer, "COUNT", BATCH];
    if (blockMs > 0) args.push("BLOCK", blockMs);
    const result = (await connection.call("XREADGROUP", ...args, "STREAMS", this.key, ">")) as [string, [string, string[]][]][] | null;
    const entries = result?.[0]?.[1] ?? [];
    for (const [id, fields] of entries) await this.process(id, fields);
    return entries.length;
  }

  /** Takes over entries abandoned by crashed consumers. */
  private async reclaim(minIdleMs: number) {
    const [, entries] = (await this.redis.xautoclaim(this.key, GROUP, this.consumer, minIdleMs, "0-0", "COUNT", BATCH)) as [
      string,
      [string, string[] | null][],
    ];
    for (const [id, fields] of entries) {
      // A null entry was trimmed from the stream before anyone processed it.
      if (fields) await this.process(id, fields);
      else await this.redis.xack(this.key, GROUP, id);
    }
  }

  private async process(id: string, fields: string[]) {
    const attemptsKey = `${this.key}:attempts`;
    try {
      const raw = fields[fields.indexOf("e") + 1];
      await this.handle(JSON.parse(raw!) as T);
      await this.redis.multi().xack(this.key, GROUP, id).hdel(attemptsKey, id).exec();
    } catch (err) {
      const attempts = await this.redis.hincrby(attemptsKey, id, 1);
      if (attempts >= MAX_ATTEMPTS) {
        // Park it where an operator can see it, rather than retrying forever.
        await this.redis
          .multi()
          .xadd(this.deadLetterKey, "*", "id", id, "error", String(err).slice(0, 500), ...fields)
          .xack(this.key, GROUP, id)
          .hdel(attemptsKey, id)
          .exec();
        this.log.error({ err, entryId: id }, "security event dead-lettered");
      } else {
        this.log.warn({ err, entryId: id, attempts }, "security event failed; will retry");
      }
    }
  }
}

function toObject(pairs: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < pairs.length; i += 2) out[String(pairs[i])] = pairs[i + 1];
  return out;
}
