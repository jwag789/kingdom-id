/**
 * An OAuth 2.0 / OIDC protocol error. `code` is the registered error code
 * (RFC 6749 §4.1.2.1, §5.2; OIDC Core §3.1.2.6); `description` is for
 * developers and is never shown with user-supplied input interpolated in.
 */
export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
  }

  toJSON() {
    return { error: this.code, error_description: this.description };
  }
}
