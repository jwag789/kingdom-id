import { type Client, type Database, type NewClient, clients } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { randomToken, safeEqual, sha256 } from "../lib/crypto.js";
import { OAuthError } from "../lib/errors.js";
import { FIRST_PARTY_ONLY_SCOPES, SUPPORTED_SCOPES } from "./scopes.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Registration-time validation (RFC 6749 §3.1.2, RFC 9700 §2.1). Returns the shared host for pairwise subjects. */
export function validateRedirectUris(uris: string[]): string {
  if (uris.length === 0) throw new Error("at least one redirect URI is required");
  const hosts = new Set<string>();
  for (const raw of uris) {
    const url = new URL(raw);
    if (url.hash) throw new Error(`redirect URI must not contain a fragment: ${raw}`);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      throw new Error(`redirect URI must use https (http is allowed only for loopback): ${raw}`);
    }
    hosts.add(url.hostname);
  }
  if (hosts.size > 1) {
    throw new Error("all redirect URIs must share one host, which is the client's pairwise sector identifier");
  }
  return [...hosts][0]!;
}

// Every first-party Kingdom app derives subjects from this one sector, so
// Cappuccino, InkSpirit and the rest see the same `sub` for the same person,
// while third-party apps each get their own.
export const FIRST_PARTY_SECTOR = "first-party.kingdomwebbuilders.com";

/** Post-logout redirect URIs follow the same rules, minus the shared-host requirement. */
export function validatePostLogoutUris(uris: string[]): void {
  for (const raw of uris) {
    const url = new URL(raw);
    if (url.hash) throw new Error(`post-logout redirect URI must not contain a fragment: ${raw}`);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      throw new Error(`post-logout redirect URI must use https (http is allowed only for loopback): ${raw}`);
    }
  }
}

export interface CreateClientInput {
  id?: string;
  name: string;
  logoUri?: string;
  type: "confidential" | "public";
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  /** A Kingdom-owned app: shares one pairwise sector with the other first-party apps. */
  firstParty?: boolean;
  allowedScopes?: string[];
  subjectType?: "public" | "pairwise";
  idTokenSignedResponseAlg?: "RS256" | "ES256";
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
  /**
   * Waives mandatory PKCE for this client. Exists for the OpenID conformance
   * suite's static clients only; never the default.
   */
  requirePkce?: boolean;
  /** Fixtures only (seed, e2e). Normal registration always generates the secret. */
  secret?: string;
}

export class ClientService {
  constructor(private readonly db: Database) {}

  async find(id: string): Promise<Client | undefined> {
    if (id.length > 128) return undefined;
    const [client] = await this.db.select().from(clients).where(eq(clients.id, id));
    return client;
  }

  /** Registers a client. The secret is returned once and only its hash is stored. */
  async create(input: CreateClientInput): Promise<{ client: Client; secret?: string }> {
    const host = validateRedirectUris(input.redirectUris);
    validatePostLogoutUris(input.postLogoutRedirectUris ?? []);
    const secret = input.type === "confidential" ? (input.secret ?? randomToken()) : undefined;
    const values: NewClient = {
      id: input.id ?? `kid_${randomToken(12)}`,
      name: input.name,
      logoUri: input.logoUri ?? null,
      type: input.type,
      secretHash: secret ? sha256(secret) : null,
      tokenEndpointAuthMethod:
        input.type === "public" ? "none" : (input.tokenEndpointAuthMethod ?? "client_secret_basic"),
      redirectUris: input.redirectUris,
      postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
      firstParty: input.firstParty ?? false,
      requirePkce: input.requirePkce ?? true,
      allowedScopes:
        input.allowedScopes ?? SUPPORTED_SCOPES.filter((s) => input.firstParty || !FIRST_PARTY_ONLY_SCOPES.includes(s)),
      subjectType: input.subjectType ?? "pairwise",
      sectorIdentifier: input.firstParty ? FIRST_PARTY_SECTOR : host,
      idTokenSignedResponseAlg: input.idTokenSignedResponseAlg ?? "RS256",
    };
    const [client] = await this.db.insert(clients).values(values).returning();
    return { client: client!, ...(secret ? { secret } : {}) };
  }

  /**
   * Authenticates the client at the token endpoint (RFC 6749 §2.3). Exactly one
   * method may be used, and it must be the one the client registered.
   */
  async authenticate(req: FastifyRequest): Promise<Client> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bodyId = typeof body.client_id === "string" ? body.client_id : undefined;
    const bodySecret = typeof body.client_secret === "string" ? body.client_secret : undefined;
    const basic = parseBasic(req.headers.authorization);

    if (basic && bodySecret) throw new OAuthError("invalid_request", "use only one client authentication method");
    if (basic && bodyId && bodyId !== basic.id) throw new OAuthError("invalid_request", "client_id mismatch");

    const method = basic ? "client_secret_basic" : bodySecret ? "client_secret_post" : "none";
    const id = basic?.id ?? bodyId;
    const secret = basic?.secret ?? bodySecret;
    const unauthorized = new OAuthError("invalid_client", "client authentication failed", 401);
    if (!id) throw unauthorized;

    const client = await this.find(id);
    if (!client || client.tokenEndpointAuthMethod !== method) throw unauthorized;
    if (method !== "none") {
      if (!secret || !client.secretHash || !safeEqual(sha256(secret), client.secretHash)) throw unauthorized;
    }
    return client;
  }
}

/** HTTP Basic per RFC 6749 §2.3.1: id and secret are form-urlencoded before base64. */
function parseBasic(header: string | undefined): { id: string; secret: string } | undefined {
  if (!header?.toLowerCase().startsWith("basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
  try {
    const formDecode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
    return { id: formDecode(decoded.slice(0, sep)), secret: formDecode(decoded.slice(sep + 1)) };
  } catch {
    throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
  }
}
