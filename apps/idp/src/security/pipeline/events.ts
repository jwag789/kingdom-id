import { randomUUID } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { FastifyRequest } from "fastify";

export type SecurityEventType =
  | "sign_in"
  | "sign_in_failed"
  | "signed_out"
  | "account_created"
  | "email_verified"
  | "passkey_added"
  | "passkey_removed"
  | "app_connected"
  | "app_disconnected"
  | "refresh_token_reuse"
  | "code_replay"
  | "mask_disabled"
  | "mask_enabled"
  | "mask_deleted"
  | "relay_spoof_blocked";

export interface SecurityEventInput {
  type: SecurityEventType;
  userId?: string | undefined;
  clientId?: string | undefined;
  details?: Record<string, unknown>;
}

/** An event as it travels on the stream: enriched at the source, so consumers never need the request. */
export interface SecurityEventEnvelope {
  id: string;
  type: SecurityEventType;
  at: string;
  userId?: string;
  clientId?: string;
  ip?: string;
  userAgent?: string;
  /** Network the request came from: /24 for IPv4, /48 for IPv6. */
  network?: string;
  /** ISO country code from a trusted CDN header, when one is present. */
  country?: string;
  details: Record<string, unknown>;
}

/**
 * The network an address belongs to. Coarse on purpose: ISPs rotate
 * addresses within a block, so the block is a steadier signal of "where"
 * than the address, without needing a GeoIP database.
 */
export function networkOf(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const address = mapped ?? ip;
  if (isIPv4(address)) return `${address.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIPv6(address)) {
    const [head = "", tail = ""] = address.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    return `${groups.slice(0, 3).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/48`;
  }
  return undefined;
}

// Set by CloudFront and Cloudflare respectively; only meaningful behind them.
const COUNTRY_HEADERS = ["cloudfront-viewer-country", "cf-ipcountry"];

export function envelope(req: FastifyRequest | undefined, input: SecurityEventInput, trustProxyHeaders: boolean): SecurityEventEnvelope {
  const ip = req?.ip;
  const network = networkOf(ip);
  const countryHeader = trustProxyHeaders
    ? COUNTRY_HEADERS.map((h) => req?.headers[h]).find((v): v is string => typeof v === "string" && /^[A-Z]{2}$/.test(v))
    : undefined;
  const userAgent = req?.headers["user-agent"]?.slice(0, 512);
  return {
    id: randomUUID(),
    type: input.type,
    at: new Date().toISOString(),
    details: input.details ?? {},
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(network ? { network } : {}),
    ...(countryHeader && countryHeader !== "XX" ? { country: countryHeader } : {}),
  };
}
