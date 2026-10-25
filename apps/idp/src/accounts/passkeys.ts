import { type Database, type Passkey, type User, passkeys, users } from "@kingdom-id/db";
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { randomToken, sha256 } from "../lib/crypto.js";
import { passkeyAmr } from "./auth-methods.js";
import { EmailTakenError, type SignupInput } from "./users.js";

// ES256 and RS256: everything a current platform authenticator offers.
const ALGORITHMS = [-7, -257];
const CHALLENGE_TTL_SECONDS = 300;

// Friendly names for the most common passkey providers, by AAGUID.
const PROVIDERS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
};

/** What a registration ceremony is for: a brand-new account, or a passkey for an existing one. */
type RegistrationIntent = { kind: "signup"; signup: Omit<SignupInput, "password">; handle: string } | { kind: "add"; userId: string };

export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

export interface PasskeyServiceOptions {
  rpID: string;
  origin: string;
}

/**
 * WebAuthn ceremonies. Challenges are single-use, live five minutes, and are
 * bound to the browser (by its CSRF cookie) that asked for them, so a
 * challenge can't be lifted into another browser.
 */
export class PasskeyService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly options: PasskeyServiceOptions,
  ) {}

  async registrationOptions(browserId: string, intent: { kind: "signup"; signup: Omit<SignupInput, "password"> } | { kind: "add"; user: User }) {
    let stored: RegistrationIntent;
    let userName: string;
    let displayName: string;
    let handle: string;
    let exclude: Passkey[] = [];
    if (intent.kind === "signup") {
      handle = randomToken();
      stored = { kind: "signup", signup: intent.signup, handle };
      userName = intent.signup.email;
      displayName = intent.signup.name;
    } else {
      handle = await this.ensureHandle(intent.user);
      stored = { kind: "add", userId: intent.user.id };
      userName = intent.user.email;
      displayName = intent.user.name;
      exclude = await this.listForUser(intent.user.id);
    }
    const options: PublicKeyCredentialCreationOptionsJSON = await generateRegistrationOptions({
      rpName: "Kingdom ID",
      rpID: this.options.rpID,
      userID: Buffer.from(handle, "base64url"),
      userName,
      userDisplayName: displayName,
      attestationType: "none",
      // Already-registered authenticators are excluded so a user can't add the same one twice.
      excludeCredentials: exclude.map((p) => ({ id: p.credentialId, transports: p.transports as never })),
      // Discoverable credentials, so sign-in needs no username; verification
      // (biometric or PIN) always, so a passkey is multi-factor on its own.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    await this.storeChallenge("register", browserId, { challenge: options.challenge, intent: stored });
    return options;
  }

  /** Verifies a registration and stores the passkey, creating the account first for a signup. */
  async register(browserId: string, response: RegistrationResponseJSON): Promise<{ user: User; passkey: Passkey }> {
    const pending = await this.takeChallenge<{ challenge: string; intent: RegistrationIntent }>("register", browserId);
    if (!pending) throw new PasskeyError("This passkey request expired. Try again.");

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.options.origin,
      expectedRPID: this.options.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    }).catch(() => ({ verified: false as const }));
    if (!verification.verified) throw new PasskeyError("Your device couldn't create a passkey. Try again.");
    const info = verification.registrationInfo;

    return this.db.transaction(async (tx) => {
      let user: User;
      const { intent } = pending;
      if (intent.kind === "signup") {
        const [created] = await tx
          .insert(users)
          .values({ email: intent.signup.email, name: intent.signup.name, webauthnUserId: intent.handle })
          .onConflictDoNothing({ target: users.email })
          .returning();
        if (!created) throw new EmailTakenError();
        user = created;
      } else {
        const [existing] = await tx.select().from(users).where(eq(users.id, intent.userId));
        if (!existing) throw new PasskeyError("Your account no longer exists.");
        user = existing;
      }
      const [passkey] = await tx
        .insert(passkeys)
        .values({
          userId: user.id,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
          signCount: info.credential.counter,
          transports: info.credential.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          aaguid: info.aaguid,
          name: PROVIDERS[info.aaguid] ?? (info.credentialBackedUp ? "Passkey" : "Security key"),
        })
        .onConflictDoNothing({ target: passkeys.credentialId })
        .returning();
      if (!passkey) throw new PasskeyError("That passkey is already registered.");
      return { user, passkey };
    });
  }

  async authenticationOptions(browserId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    // No allowCredentials: the authenticator offers whichever Kingdom passkeys
    // it holds, so the user never types a username.
    const options = await generateAuthenticationOptions({ rpID: this.options.rpID, userVerification: "required" });
    await this.storeChallenge("authenticate", browserId, { challenge: options.challenge });
    return options;
  }

  /** Verifies an assertion and returns who signed in and how (amr). */
  async authenticate(browserId: string, response: AuthenticationResponseJSON): Promise<{ user: User; amr: string[] }> {
    const pending = await this.takeChallenge<{ challenge: string }>("authenticate", browserId);
    if (!pending) throw new PasskeyError("This sign-in request expired. Try again.");

    const [row] = await this.db
      .select({ passkey: passkeys, user: users })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(eq(passkeys.credentialId, response.id));
    if (!row) throw new PasskeyError("That passkey isn't registered with Kingdom ID.");
    const { passkey, user } = row;
    // The authenticator reports which user the credential belongs to; it must agree with our records.
    if (response.response.userHandle && response.response.userHandle !== user.webauthnUserId) {
      throw new PasskeyError("That passkey isn't registered with Kingdom ID.");
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.options.origin,
      expectedRPID: this.options.rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, "base64url"),
        counter: passkey.signCount,
        transports: passkey.transports as never,
      },
      // Rejects a signature counter that went backwards (a cloned authenticator).
    }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
    if (!verification.verified || !verification.authenticationInfo) {
      throw new PasskeyError("That passkey couldn't be verified. Try again.");
    }
    const info = verification.authenticationInfo;
    await this.db
      .update(passkeys)
      .set({ signCount: info.newCounter, backedUp: info.credentialBackedUp, lastUsedAt: sql`now()` })
      .where(eq(passkeys.id, passkey.id));
    return { user, amr: passkeyAmr(info.credentialBackedUp) };
  }

  async listForUser(userId: string): Promise<Passkey[]> {
    return this.db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(passkeys.createdAt);
  }

  /** Removes a passkey, unless it's the account's last way to sign in. */
  async remove(user: User, passkeyId: string): Promise<void> {
    const all = await this.listForUser(user.id);
    if (!all.some((p) => p.id === passkeyId)) throw new PasskeyError("That passkey isn't on your account.");
    if (all.length === 1 && !user.passwordHash) {
      throw new PasskeyError("This is your only way to sign in. Add another passkey or a password first.");
    }
    await this.db.delete(passkeys).where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, user.id)));
  }

  private async ensureHandle(user: User): Promise<string> {
    if (user.webauthnUserId) return user.webauthnUserId;
    const handle = randomToken();
    const [updated] = await this.db
      .update(users)
      .set({ webauthnUserId: sql`coalesce(${users.webauthnUserId}, ${handle})` })
      .where(eq(users.id, user.id))
      .returning({ handle: users.webauthnUserId });
    return updated!.handle!;
  }

  private async storeChallenge(purpose: string, browserId: string, value: object) {
    await this.redis.set(this.key(purpose, browserId), JSON.stringify(value), "EX", CHALLENGE_TTL_SECONDS);
  }

  private async takeChallenge<T>(purpose: string, browserId: string): Promise<T | undefined> {
    const raw = await this.redis.getdel(this.key(purpose, browserId));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  private key(purpose: string, browserId: string) {
    return `webauthn:${purpose}:${sha256(browserId)}`;
  }
}
