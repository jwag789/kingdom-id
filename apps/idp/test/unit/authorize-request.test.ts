import type { Client } from "@kingdom-id/db";
import { describe, expect, it } from "vitest";
import {
  RedirectableError,
  UntrustedRedirectError,
  buildRedirect,
  parseAuthorizationRequest,
} from "../../src/oauth/authorize.js";
import { sha256 } from "../../src/lib/crypto.js";

const client = {
  id: "app",
  name: "App",
  redirectUris: ["https://app.example.com/cb"],
  allowedScopes: ["openid", "profile", "email"],
} as unknown as Client;
const find = async (id: string) => (id === client.id ? client : undefined);

const valid = {
  client_id: "app",
  redirect_uri: "https://app.example.com/cb",
  response_type: "code",
  scope: "openid email",
  state: "s1",
  code_challenge: sha256("v".repeat(43)),
  code_challenge_method: "S256",
};

const parse = (overrides: Record<string, string | string[] | undefined>) =>
  parseAuthorizationRequest({ ...valid, ...overrides }, find);

async function redirectCode(overrides: Record<string, string | string[] | undefined>) {
  const err = await parse(overrides).catch((e) => e);
  expect(err).toBeInstanceOf(RedirectableError);
  return (err as RedirectableError).code;
}

describe("authorization request validation", () => {
  it("accepts a valid request and narrows scopes", async () => {
    const { request } = await parse({ scope: "openid email unknown_scope" });
    expect(request.scopes).toEqual(["openid", "email"]);
    expect(request.state).toBe("s1");
  });

  it("never redirects for an unknown client or an unregistered redirect URI", async () => {
    await expect(parse({ client_id: "nope" })).rejects.toBeInstanceOf(UntrustedRedirectError);
    await expect(parse({ client_id: undefined })).rejects.toBeInstanceOf(UntrustedRedirectError);
    // Exact matching: no prefix, case, trailing-slash or query tolerance.
    for (const uri of [
      "https://app.example.com/cb/",
      "https://app.example.com/cb?x=1",
      "https://APP.example.com/cb",
      "https://app.example.com/cb/../evil",
      "https://evil.example.com/cb",
    ]) {
      await expect(parse({ redirect_uri: uri })).rejects.toBeInstanceOf(UntrustedRedirectError);
    }
  });

  it("requires PKCE with S256", async () => {
    expect(await redirectCode({ code_challenge: undefined })).toBe("invalid_request");
    expect(await redirectCode({ code_challenge_method: undefined })).toBe("invalid_request");
    expect(await redirectCode({ code_challenge_method: "plain" })).toBe("invalid_request");
    expect(await redirectCode({ code_challenge: "short" })).toBe("invalid_request");
  });

  it("validates response_type, scope, prompt, max_age and parameter shape", async () => {
    expect(await redirectCode({ response_type: "token" })).toBe("unsupported_response_type");
    expect(await redirectCode({ response_type: undefined })).toBe("invalid_request");
    expect(await redirectCode({ scope: "email" })).toBe("invalid_scope");
    expect(await redirectCode({ prompt: "none login" })).toBe("invalid_request");
    expect(await redirectCode({ prompt: "bogus" })).toBe("invalid_request");
    expect(await redirectCode({ max_age: "-1" })).toBe("invalid_request");
    expect(await redirectCode({ response_mode: "fragment" })).toBe("invalid_request");
    expect(await redirectCode({ request: "eyJ..." })).toBe("request_not_supported");
    expect(await redirectCode({ request_uri: "https://x" })).toBe("request_uri_not_supported");
    expect(await redirectCode({ scope: ["openid", "openid"] })).toBe("invalid_request");
    expect(await redirectCode({ nonce: "n".repeat(2000) })).toBe("invalid_request");
  });

  it("builds redirects that keep an existing query", () => {
    const url = new URL(buildRedirect("https://a.example.com/cb?tenant=1", { code: "c", state: undefined }));
    expect(url.searchParams.get("tenant")).toBe("1");
    expect(url.searchParams.get("code")).toBe("c");
    expect(url.searchParams.has("state")).toBe(false);
  });
});
