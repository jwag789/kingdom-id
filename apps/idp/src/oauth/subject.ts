import type { Client } from "@kingdom-id/db";
import { hmac } from "../lib/crypto.js";

/**
 * The `sub` a client sees. Pairwise subjects (OIDC Core §8.1) differ per
 * sector, so two unrelated apps can't correlate a user by `sub`. That pairs
 * with the per-app relay email coming in phase 6.
 */
export function subjectFor(secret: Buffer, client: Pick<Client, "subjectType" | "sectorIdentifier">, userId: string) {
  if (client.subjectType === "public") return userId;
  return hmac(secret, `pairwise:${client.sectorIdentifier}:${userId}`);
}

/** Per-client session ID for the `sid` claim, so apps can't link sessions across each other either. */
export function sessionIdFor(secret: Buffer, clientId: string, sessionId: string) {
  return hmac(secret, `sid:${clientId}:${sessionId}`);
}
