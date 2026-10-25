import type { Client } from "@kingdom-id/db";
import { OAuthError } from "../lib/errors.js";
import { isValidChallenge } from "./pkce.js";
import { parseScope } from "./scopes.js";

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  nonce?: string;
  /** Absent only for clients registered with requirePkce=false that didn't send one. */
  codeChallenge?: string;
  prompt: Prompt[];
  maxAge?: number;
  loginHint?: string;
  idTokenHint?: string;
}

const PROMPTS = ["none", "login", "consent", "select_account", "create"] as const;
type Prompt = (typeof PROMPTS)[number];

// Bounds on attacker-controlled strings that end up stored in Redis.
const MAX_PARAM = 1024;

/**
 * An error the user must see on our own page because the redirect URI can't
 * be trusted yet (unknown client, unregistered redirect_uri). RFC 6749
 * §4.1.2.1 forbids redirecting in that case: doing so would be an open redirect.
 */
export class UntrustedRedirectError extends Error {
  constructor(
    public readonly title: string,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "UntrustedRedirectError";
  }
}

/** An error returned to the client on its (verified) redirect URI. */
export class RedirectableError extends OAuthError {
  constructor(
    code: string,
    description: string,
    public readonly redirectUri: string,
    public readonly state: string | undefined,
  ) {
    super(code, description);
    this.name = "RedirectableError";
  }
}

type Params = Record<string, string | string[] | undefined>;

export async function parseAuthorizationRequest(
  params: Params,
  findClient: (id: string) => Promise<Client | undefined>,
): Promise<{ client: Client; request: AuthorizationRequest }> {
  // Step 1: establish a trusted redirect URI. Until then, nothing redirects.
  const clientId = params.client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new UntrustedRedirectError("Missing application", "The request didn't say which app is asking you to sign in.");
  }
  const client = await findClient(clientId);
  if (!client) {
    throw new UntrustedRedirectError("Unknown application", "This sign-in link names an app Kingdom ID doesn't recognize.");
  }
  const redirectUri = params.redirect_uri;
  // Exact string comparison, no normalization, no prefix or wildcard matching.
  if (typeof redirectUri !== "string" || !client.redirectUris.includes(redirectUri)) {
    throw new UntrustedRedirectError(
      "Unrecognized return address",
      `${client.name} asked to send you back to an address it hasn't registered, so Kingdom ID stopped here.`,
    );
  }

  const state = typeof params.state === "string" ? params.state : undefined;
  const fail = (code: string, description: string): never => {
    throw new RedirectableError(code, description, redirectUri, state);
  };

  // Step 2: everything else is reported back to the client.
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) fail("invalid_request", `parameter repeated: ${name}`);
    if (typeof value === "string" && value.length > MAX_PARAM) fail("invalid_request", `parameter too long: ${name}`);
  }
  const p = params as Record<string, string | undefined>;

  if (p.request !== undefined) fail("request_not_supported", "request objects are not supported");
  if (p.request_uri !== undefined) fail("request_uri_not_supported", "request_uri is not supported");
  if (!p.response_type) fail("invalid_request", "response_type is required");
  if (p.response_type !== "code") fail("unsupported_response_type", "only response_type=code is supported");
  if (p.response_mode !== undefined && p.response_mode !== "query") {
    fail("invalid_request", "only response_mode=query is supported");
  }

  const requested = new Set((p.scope ?? "").split(" "));
  if (!requested.has("openid")) fail("invalid_scope", "the openid scope is required");
  const scopes = parseScope(p.scope, client.allowedScopes);

  // PKCE is mandatory for every client, confidential ones included (RFC 9700 §2.1.1),
  // unless the client was registered with an explicit waiver. Whenever PKCE
  // is used it must be S256: `plain` offers no protection if the request is observed.
  if (!p.code_challenge && client.requirePkce) fail("invalid_request", "code_challenge is required (PKCE)");
  if (p.code_challenge) {
    if (p.code_challenge_method !== "S256") fail("invalid_request", "code_challenge_method must be S256");
    if (!isValidChallenge(p.code_challenge)) fail("invalid_request", "code_challenge is malformed");
  } else if (p.code_challenge_method !== undefined) {
    fail("invalid_request", "code_challenge_method without code_challenge");
  }

  const prompt = (p.prompt ?? "").split(" ").filter(Boolean) as Prompt[];
  if (prompt.some((v) => !PROMPTS.includes(v))) fail("invalid_request", "unsupported prompt value");
  if (prompt.includes("none") && prompt.length > 1) fail("invalid_request", "prompt=none can't be combined");

  let maxAge: number | undefined;
  if (p.max_age !== undefined) {
    if (!/^\d{1,10}$/.test(p.max_age)) fail("invalid_request", "max_age must be a non-negative integer");
    maxAge = Number(p.max_age);
  }

  return {
    client,
    request: {
      clientId: client.id,
      redirectUri,
      scopes,
      ...(p.code_challenge ? { codeChallenge: p.code_challenge } : {}),
      prompt,
      ...(state !== undefined ? { state } : {}),
      ...(p.nonce !== undefined ? { nonce: p.nonce } : {}),
      ...(maxAge !== undefined ? { maxAge } : {}),
      ...(p.login_hint ? { loginHint: p.login_hint.slice(0, 254) } : {}),
      ...(p.id_token_hint ? { idTokenHint: p.id_token_hint } : {}),
    },
  };
}

/** Appends response parameters to a redirect URI, preserving any query it already has. */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}
