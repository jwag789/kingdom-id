import type { Redis } from "ioredis";
import { randomToken, safeEqual, sha256 } from "../lib/crypto.js";
import type { AuthorizationRequest } from "./authorize.js";

/**
 * The state of one authorization request while the user signs in and
 * consents. It's bound to the browser that started it, so a link to someone
 * else's interaction is useless.
 */
export interface Interaction {
  id: string;
  browserHash: string;
  request: AuthorizationRequest;
  /** Set when prompt=login or max_age demands a fresh sign-in within this interaction. */
  forceLogin: boolean;
  /** Session created by signing in during this interaction, if any. */
  loginSessionId?: string;
}

export class InteractionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async create(browserId: string, request: AuthorizationRequest, forceLogin: boolean): Promise<Interaction> {
    const interaction: Interaction = { id: randomToken(16), browserHash: sha256(browserId), request, forceLogin };
    await this.redis.set(this.key(interaction.id), JSON.stringify(interaction), "EX", this.ttlSeconds);
    return interaction;
  }

  async get(id: string, browserId: string): Promise<Interaction | undefined> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return undefined;
    const raw = await this.redis.get(this.key(id));
    if (!raw) return undefined;
    const interaction = JSON.parse(raw) as Interaction;
    return safeEqual(interaction.browserHash, sha256(browserId)) ? interaction : undefined;
  }

  async save(interaction: Interaction): Promise<void> {
    await this.redis.set(this.key(interaction.id), JSON.stringify(interaction), "KEEPTTL");
  }

  /** Deletes and reports whether this call was the one that deleted it, so completion happens once. */
  async consume(id: string): Promise<boolean> {
    return (await this.redis.del(this.key(id))) === 1;
  }

  private key(id: string) {
    return `ixn:${id}`;
  }
}
