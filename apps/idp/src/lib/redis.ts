import { Redis } from "ioredis";

export type { Redis };

export function connectRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
}
