import { type Client, type Database, type Grant, grants } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import type { KeyStore } from "../keys/keystore.js";
import { randomToken } from "../lib/crypto.js";
import type { EventStream } from "../security/pipeline/stream.js";
import type { ClientService } from "./clients.js";
import { sessionIdFor, subjectFor } from "./subject.js";

/** The event that marks a JWT as a logout token (OIDC Back-Channel Logout 1.0 §2.4). */
export const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/** One logout notice waiting to be delivered to one app. */
export interface LogoutDelivery {
  id: string;
  clientId: string;
  sub: string;
  /** The app's `sid` for the session being ended; absent when every session ends (disconnect). */
  sid?: string;
  reason: "logout" | "disconnected" | "token_theft";
  at: string;
}

export interface BackchannelOptions {
  issuer: string;
  serverSecret: Buffer;
  timeoutMs?: number;
}

/**
 * OpenID Connect Back-Channel Logout. When a Kingdom session ends, or a user
 * disconnects an app, the affected apps are told server-to-server so they can
 * end their own sessions. Notices queue on a Redis Stream, so a slow or down
 * app gets retries (and eventually a dead letter) without holding up the
 * user's request.
 */
export class BackchannelLogout {
  constructor(
    private readonly db: Database,
    private readonly clients: ClientService,
    private readonly keys: KeyStore,
    private readonly stream: EventStream<LogoutDelivery>,
    private readonly options: BackchannelOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The user signed out of Kingdom: tell every app that got tokens from this session. */
  async forSession(sessionId: string, userId: string): Promise<void> {
    const rows = await this.db.selectDistinct({ clientId: grants.clientId }).from(grants).where(eq(grants.sessionId, sessionId));
    for (const { clientId } of rows) {
      const client = await this.clients.find(clientId);
      if (!client?.backchannelLogoutUri) continue;
      await this.enqueue({
        clientId,
        sub: subjectFor(this.options.serverSecret, client, userId),
        sid: sessionIdFor(this.options.serverSecret, client.id, sessionId),
        reason: "logout",
      });
    }
  }

  /** The user disconnected an app: end every session they have there. */
  async forDisconnect(userId: string, client: Client): Promise<void> {
    if (!client.backchannelLogoutUri) return;
    await this.enqueue({ clientId: client.id, sub: subjectFor(this.options.serverSecret, client, userId), reason: "disconnected" });
  }

  /** A grant's tokens were found to be stolen (reuse or code replay): end that session at the app. */
  async forCompromisedGrant(grant: Grant): Promise<void> {
    const client = await this.clients.find(grant.clientId);
    if (!client?.backchannelLogoutUri) return;
    await this.enqueue({
      clientId: client.id,
      sub: grant.subject,
      ...(grant.sessionId ? { sid: sessionIdFor(this.options.serverSecret, client.id, grant.sessionId) } : {}),
      reason: "token_theft",
    });
  }

  /** Stream handler: signs and POSTs one logout token. Throws on failure so the stream retries. */
  async deliver(notice: LogoutDelivery): Promise<void> {
    const client = await this.clients.find(notice.clientId);
    if (!client?.backchannelLogoutUri) return; // unregistered since; nothing to do
    const logoutToken = await this.sign(client, notice);
    const res = await this.fetchImpl(client.backchannelLogoutUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: logoutToken }),
      // The URI is admin-registered, but never follow it elsewhere.
      redirect: "manual",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`back-channel logout to ${client.id} failed with ${res.status}`);
  }

  /** A logout token (§2.4): like an ID token, but with an `events` claim and never a nonce. */
  async sign(client: Client, notice: LogoutDelivery): Promise<string> {
    const key = await this.keys.getActiveKey(client.idTokenSignedResponseAlg);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      ...(notice.sid ? { sid: notice.sid } : {}),
    })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "logout+jwt" })
      .setIssuer(this.options.issuer)
      .setAudience(client.id)
      .setSubject(notice.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomToken(16))
      .sign(key.key);
  }

  private async enqueue(notice: Omit<LogoutDelivery, "id" | "at">) {
    await this.stream.publish({ ...notice, id: randomToken(16), at: new Date().toISOString() });
  }
}
