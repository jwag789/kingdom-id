import { type Database, type SigningKey, signingKeys } from "@kingdom-id/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
  type JWTVerifyOptions,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
} from "jose";
import { decrypt, encrypt } from "../lib/crypto.js";

export type SigningAlg = "RS256" | "ES256";
export const SIGNING_ALGS: readonly SigningAlg[] = ["RS256", "ES256"];

// Keys in these states are published in the JWKS. `next` is published ahead
// of use so relying parties have already cached it when it becomes active;
// `retiring` stays published so tokens it signed keep verifying.
const PUBLISHED: SigningKey["status"][] = ["next", "active", "retiring"];

// Each instance re-reads keys from Postgres at most this often, so a rotation
// performed by one instance reaches the others within this window. Safe because
// a key is published (as `next`) a full rotation interval before it signs.
const CACHE_TTL_MS = 30_000;

// Arbitrary constant naming the advisory lock that serializes rotation across
// instances.
const ROTATION_LOCK_ID = 0x4b49_4421; // "KID!"

export interface ActiveKey {
  kid: string;
  alg: SigningAlg;
  key: CryptoKey;
}

export interface KeyStoreOptions {
  rotationIntervalSeconds: number;
  retirementGraceSeconds: number;
}

export class KeyStore {
  private cache: { at: number; jwks: JSONWebKeySet; active: Map<SigningAlg, ActiveKey> } | undefined;

  constructor(
    private readonly db: Database,
    private readonly kek: Buffer,
    private readonly options: KeyStoreOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates an active and a next key for any algorithm that lacks them. */
  async ensureKeys(): Promise<void> {
    await this.withRotationLock(async (tx) => {
      for (const alg of SIGNING_ALGS) {
        const rows = await tx
          .select({ status: signingKeys.status })
          .from(signingKeys)
          .where(and(eq(signingKeys.alg, alg), inArray(signingKeys.status, ["active", "next"])));
        const statuses = new Set(rows.map((r) => r.status));
        if (!statuses.has("active")) await this.insertKey(tx, alg, "active");
        if (!statuses.has("next")) await this.insertKey(tx, alg, "next");
      }
    });
    this.invalidate();
  }

  /**
   * Advances the lifecycle for `alg`: active → retiring, next → active, and a
   * freshly generated key becomes next. Retiring keys past their grace period
   * are retired (removed from the JWKS) in the same transaction.
   */
  async rotate(alg: SigningAlg): Promise<void> {
    await this.withRotationLock((tx) => this.rotateLocked(tx, alg));
    this.invalidate();
  }

  /** Rotates any algorithm whose active key is older than the interval. Safe to call from every instance. */
  async rotateIfDue(): Promise<SigningAlg[]> {
    const rotated: SigningAlg[] = [];
    await this.withRotationLock(async (tx) => {
      await this.retireExpired(tx);
      const cutoff = new Date(this.now().getTime() - this.options.rotationIntervalSeconds * 1000);
      for (const alg of SIGNING_ALGS) {
        const [active] = await tx
          .select()
          .from(signingKeys)
          .where(and(eq(signingKeys.alg, alg), eq(signingKeys.status, "active")));
        if (!active || (active.activatedAt ?? active.createdAt) <= cutoff) {
          await this.rotateLocked(tx, alg);
          rotated.push(alg);
        }
      }
    });
    this.invalidate();
    return rotated;
  }

  async getActiveKey(alg: SigningAlg): Promise<ActiveKey> {
    const { active } = await this.load();
    const key = active.get(alg);
    if (!key) throw new Error(`no active ${alg} signing key; run ensureKeys()`);
    return key;
  }

  async jwks(): Promise<JSONWebKeySet> {
    return (await this.load()).jwks;
  }

  /** Verifies a JWT signed by one of our published keys. */
  async verify<T extends JWTPayload>(token: string, options: JWTVerifyOptions): Promise<T> {
    const { payload } = await jwtVerify<T>(token, createLocalJWKSet(await this.jwks()), options);
    return payload;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async load() {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache;
    const rows = await this.db.select().from(signingKeys).where(inArray(signingKeys.status, PUBLISHED));
    const active = new Map<SigningAlg, ActiveKey>();
    for (const row of rows.filter((r) => r.status === "active")) {
      const jwk = JSON.parse(decrypt(this.kek, row.privateJwkEncrypted, row.kid)) as JWK;
      active.set(row.alg, { kid: row.kid, alg: row.alg, key: (await importJWK(jwk, row.alg)) as CryptoKey });
    }
    // Stable order: active first so naive clients that take keys[0] pick the signing key.
    const order = { active: 0, next: 1, retiring: 2, retired: 3 } as const;
    const keys = rows
      .sort((a, b) => order[a.status] - order[b.status])
      .map((r) => r.publicJwk as JWK);
    this.cache = { at: Date.now(), jwks: { keys }, active };
    return this.cache;
  }

  private async rotateLocked(tx: Tx, alg: SigningAlg): Promise<void> {
    const now = this.now();
    await this.retireExpired(tx);
    await tx
      .update(signingKeys)
      .set({ status: "retiring", retiringAt: now })
      .where(and(eq(signingKeys.alg, alg), eq(signingKeys.status, "active")));
    const promoted = await tx
      .update(signingKeys)
      .set({ status: "active", activatedAt: now })
      .where(and(eq(signingKeys.alg, alg), eq(signingKeys.status, "next")))
      .returning({ kid: signingKeys.kid });
    // A missing `next` only happens if keys were tampered with; recover by
    // generating an active key directly rather than leaving the alg unsigned.
    if (promoted.length === 0) await this.insertKey(tx, alg, "active");
    await this.insertKey(tx, alg, "next");
  }

  private async retireExpired(tx: Tx): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.options.retirementGraceSeconds * 1000);
    await tx
      .update(signingKeys)
      .set({ status: "retired", retiredAt: this.now() })
      .where(and(eq(signingKeys.status, "retiring"), lt(signingKeys.retiringAt, cutoff)));
  }

  private async insertKey(tx: Tx, alg: SigningAlg, status: "active" | "next"): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair(alg, {
      extractable: true,
      ...(alg === "RS256" ? { modulusLength: 2048 } : {}),
    });
    const publicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    const privateJwk = await exportJWK(privateKey);
    const now = this.now();
    await tx.insert(signingKeys).values({
      kid,
      alg,
      status,
      publicJwk: { ...publicJwk, kid, alg, use: "sig" },
      // The kid is bound in as AAD so a ciphertext can't be swapped onto another row.
      privateJwkEncrypted: encrypt(this.kek, JSON.stringify(privateJwk), kid),
      createdAt: now,
      activatedAt: status === "active" ? now : null,
    });
  }

  private withRotationLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROTATION_LOCK_ID})`);
      return fn(tx);
    });
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Runs `rotateIfDue` on an interval. Every instance runs it; the advisory lock makes that safe. */
export function startRotationScheduler(
  store: KeyStore,
  onError: (err: unknown) => void,
  everyMs = 60 * 60 * 1000,
): () => void {
  const timer = setInterval(() => store.rotateIfDue().catch(onError), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
