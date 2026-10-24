import type { Database } from "@kingdom-id/db";
import type { Redis } from "ioredis";
import type { EmailVerification } from "./accounts/email-verification.js";
import type { SessionService } from "./accounts/sessions.js";
import type { UserService } from "./accounts/users.js";
import type { Config } from "./config.js";
import type { KeyStore } from "./keys/keystore.js";
import type { ClientService } from "./oauth/clients.js";
import type { AccessTokenVerifier } from "./oauth/access-tokens.js";
import type { CodeStore } from "./oauth/codes.js";
import type { ConsentService } from "./oauth/consents.js";
import type { GrantService } from "./oauth/grants.js";
import type { InteractionStore } from "./oauth/interactions.js";
import type { TokenService } from "./oauth/tokens.js";
import type { Csrf } from "./security/csrf.js";
import type { RateLimiter } from "./security/rate-limit.js";

/** Everything route handlers depend on, assembled once in buildApp. */
export interface Context {
  config: Config;
  db: Database;
  redis: Redis;
  serverSecret: Buffer;
  keys: KeyStore;
  users: UserService;
  sessions: SessionService;
  sessionCookie: string;
  emailVerification: EmailVerification;
  clients: ClientService;
  consents: ConsentService;
  codes: CodeStore;
  interactions: InteractionStore;
  grants: GrantService;
  tokens: TokenService;
  accessTokens: AccessTokenVerifier;
  csrf: Csrf;
  rateLimiter: RateLimiter;
}
