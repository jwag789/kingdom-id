import type { Redis } from "ioredis";
import { sha256 } from "../lib/crypto.js";

/**
 * Sliding-window log in a Redis sorted set. Exact (no fixed-window burst at
 * the boundary), atomic via Lua, and uses the Redis clock so every API
 * instance agrees on time.
 */
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + window - now}
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return {1, 0}
`;

export interface Rule {
  /** Bucket name, e.g. "login:ip". */
  name: string;
  /** What the bucket counts per: an IP, a client_id, a hashed email. */
  key: string;
  limit: number;
  windowSeconds: number;
}

export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("rate limited");
    this.name = "RateLimitedError";
  }
}

let seq = 0;

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly multiplier = 1,
  ) {}

  /** Consumes one unit from every rule; throws RateLimitedError if any is exhausted. */
  async consume(rules: Rule[]): Promise<void> {
    for (const rule of rules) {
      // Keys are hashed so raw emails and IPs never sit in Redis key names.
      const key = `rl:${rule.name}:${sha256(rule.key)}`;
      const member = `${process.pid}:${Date.now()}:${seq++}`;
      const [allowed, retryMs] = (await this.redis.eval(
        SCRIPT,
        1,
        key,
        rule.windowSeconds * 1000,
        Math.ceil(rule.limit * this.multiplier),
        member,
      )) as [number, number];
      if (allowed !== 1) throw new RateLimitedError(Math.max(1, Math.ceil(retryMs / 1000)));
    }
  }
}

/** Default limits. Tuned for interactive use; the k6 run in phase 8 revisits the token endpoint. */
export const limits = {
  authorize: (ip: string): Rule[] => [{ name: "authorize:ip", key: ip, limit: 60, windowSeconds: 60 }],
  login: (ip: string, email: string): Rule[] => [
    { name: "login:ip", key: ip, limit: 20, windowSeconds: 60 },
    // Per-account throttle against credential stuffing. It slows, not locks:
    // the window slides, so a victim is never locked out for long.
    { name: "login:account", key: email.toLowerCase(), limit: 10, windowSeconds: 15 * 60 },
  ],
  passkeyOptions: (ip: string): Rule[] => [{ name: "passkey:ip", key: ip, limit: 30, windowSeconds: 60 }],
  signup: (ip: string): Rule[] => [{ name: "signup:ip", key: ip, limit: 10, windowSeconds: 60 * 60 }],
  tokenByIp: (ip: string): Rule[] => [{ name: "token:ip", key: ip, limit: 120, windowSeconds: 60 }],
  tokenByClient: (clientId: string): Rule[] => [{ name: "token:client", key: clientId, limit: 600, windowSeconds: 60 }],
  userinfo: (ip: string): Rule[] => [{ name: "userinfo:ip", key: ip, limit: 120, windowSeconds: 60 }],
};
