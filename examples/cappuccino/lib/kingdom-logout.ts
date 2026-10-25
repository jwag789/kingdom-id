import { createRemoteJWKSet, jwtVerify } from "jose";
import { KINGDOM_ISSUER } from "@/auth";

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/**
 * Sessions Kingdom ID told us to end. Auth.js sessions are stateless cookies,
 * so ending one means remembering it here and refusing it on its next use.
 *
 * In-memory for this one-process example. With several app servers, keep
 * this in Redis or your database so every server sees every logout.
 */
interface LogoutState {
  /** Kingdom session IDs (`sid`) that have ended. */
  sids: Set<string>;
  /** Users (`sub`) whose every session before this time has ended (they disconnected the app). */
  subsBefore: Map<string, number>;
  /** Logout token IDs already processed, so a replayed token is rejected. */
  jtis: Set<string>;
}
const state: LogoutState = ((globalThis as { __kingdomLogout?: LogoutState }).__kingdomLogout ??= {
  sids: new Set(),
  subsBefore: new Map(),
  jtis: new Set(),
});

/** Called from the Auth.js jwt callback on every request. */
export function isLoggedOut(session: { sid?: unknown; kingdomSub?: unknown; signedInAt?: unknown }): boolean {
  if (typeof session.sid === "string" && state.sids.has(session.sid)) return true;
  const cutoff = typeof session.kingdomSub === "string" ? state.subsBefore.get(session.kingdomSub) : undefined;
  return cutoff !== undefined && typeof session.signedInAt === "number" && session.signedInAt <= cutoff;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
async function kingdomKeys() {
  if (!jwks) {
    const discovery = (await (await fetch(`${KINGDOM_ISSUER}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  }
  return jwks;
}

/**
 * Validates a logout token per OIDC Back-Channel Logout 1.0 §2.6 and records
 * the logout. Throws if the token isn't a valid logout token for this app.
 */
export async function acceptLogoutToken(logoutToken: string): Promise<void> {
  const { payload } = await jwtVerify(logoutToken, await kingdomKeys(), {
    issuer: KINGDOM_ISSUER,
    audience: process.env.AUTH_KINGDOM_ID,
    typ: "logout+jwt",
    maxTokenAge: "2 minutes",
  });
  const events = payload.events as Record<string, unknown> | undefined;
  if (!events || typeof events[LOGOUT_EVENT] !== "object") throw new Error("not a logout token");
  if ("nonce" in payload) throw new Error("logout tokens never carry a nonce");
  if (!payload.sub && !payload.sid) throw new Error("logout token names no user or session");
  if (!payload.jti || state.jtis.has(payload.jti)) throw new Error("logout token replayed");
  state.jtis.add(payload.jti);

  if (typeof payload.sid === "string") state.sids.add(payload.sid);
  else if (payload.sub) state.subsBefore.set(payload.sub, Math.floor(Date.now() / 1000));
}
