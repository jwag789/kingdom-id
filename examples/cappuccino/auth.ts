import NextAuth from "next-auth";
import type { OIDCConfig } from "next-auth/providers";

/** One perk from the `perks` claim (first-party Kingdom apps only). */
export interface KingdomPerk {
  id: string;
  name: string;
  app: string;
}

/** What Kingdom ID's UserInfo endpoint returns for the scopes Cappuccino asks for. */
interface KingdomProfile {
  sub: string;
  name?: string;
  /** A private relay address unique to Cappuccino, never the member's real one. */
  email?: string;
  email_verified?: boolean;
  perks?: KingdomPerk[];
}

export const KINGDOM_ISSUER = process.env.KINGDOM_ISSUER ?? "https://id.kingdomwebbuilders.com";

/**
 * Sign in with Kingdom. Kingdom ID is a standard OpenID Connect provider, so
 * this is Auth.js's generic OIDC provider with three Kingdom-specific choices:
 *
 * - `idToken: false`: Kingdom ID keeps personal data out of ID tokens and
 *   releases it through UserInfo (OIDC Core §5.4). Auth.js still validates
 *   the ID token, then fetches UserInfo for the profile.
 * - `checks`: PKCE is mandatory at Kingdom ID; state and nonce add CSRF and
 *   replay protection on top.
 * - `perks`: only first-party Kingdom apps may request it.
 */
const Kingdom: OIDCConfig<KingdomProfile> = {
  id: "kingdom",
  name: "Kingdom",
  type: "oidc",
  issuer: KINGDOM_ISSUER,
  clientId: process.env.AUTH_KINGDOM_ID,
  clientSecret: process.env.AUTH_KINGDOM_SECRET,
  authorization: { params: { scope: "openid profile email perks" } },
  checks: ["pkce", "state", "nonce"],
  idToken: false,
  profile(profile) {
    return { id: profile.sub, name: profile.name ?? null, email: profile.email ?? null };
  },
};

declare module "next-auth" {
  interface Session {
    perks: KingdomPerk[];
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Kingdom],
  callbacks: {
    jwt({ token, account, profile }) {
      // Runs at sign-in with the tokens and profile, then on every request with just the token.
      if (account && profile) {
        token.perks = (profile as unknown as KingdomProfile).perks ?? [];
        // Kept in the encrypted session cookie for RP-initiated logout; never sent to the browser.
        token.idToken = account.id_token;
      }
      return token;
    },
    session({ session, token }) {
      session.perks = (token.perks as KingdomPerk[] | undefined) ?? [];
      return session;
    },
  },
});
