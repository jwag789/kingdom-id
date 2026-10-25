import type { Redis } from "ioredis";
import { randomToken, sha256 } from "../lib/crypto.js";

export interface CodeGrant {
  clientId: string;
  userId: string;
  sessionId: string;
  sub: string;
  redirectUri: string;
  scopes: string[];
  nonce?: string;
  codeChallenge?: string;
  authTime: number;
  amr: string[];
}

export type Redemption = { status: "ok"; grant: CodeGrant } | { status: "replayed"; clientId: string } | { status: "invalid" };

// How long a redeemed code is remembered, so a second redemption is reported
// as a replay rather than as an unknown code.
const REPLAY_WINDOW_SECONDS = 600;

/** Authorization codes live only in Redis, keyed by hash, and are redeemable exactly once. */
export class CodeStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async issue(grant: CodeGrant): Promise<string> {
    const code = randomToken();
    await this.redis.set(`code:${sha256(code)}`, JSON.stringify(grant), "EX", this.ttlSeconds);
    return code;
  }

  async redeem(code: string): Promise<Redemption> {
    if (code.length > 64) return { status: "invalid" };
    const hash = sha256(code);
    // GETDEL is atomic: two concurrent redemptions can't both succeed.
    const raw = await this.redis.getdel(`code:${hash}`);
    if (!raw) {
      const replayed = await this.redis.get(`code-used:${hash}`);
      return replayed ? { status: "replayed", clientId: replayed } : { status: "invalid" };
    }
    const grant = JSON.parse(raw) as CodeGrant;
    await this.redis.set(`code-used:${hash}`, grant.clientId, "EX", REPLAY_WINDOW_SECONDS);
    return { status: "ok", grant };
  }
}
