import { type DatabaseHandle, connect, signingKeys } from "@kingdom-id/db";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyStore } from "../../src/keys/keystore.js";
import { freshDatabaseUrl } from "../helpers.js";

const DAY = 24 * 60 * 60;
const kek = Buffer.alloc(32, 3);

describe("signing key lifecycle", () => {
  let handle: DatabaseHandle;
  let now: Date;
  let store: KeyStore;

  beforeEach(async () => {
    handle = connect(await freshDatabaseUrl(), { max: 2 });
    now = new Date("2026-01-01T00:00:00Z");
    store = new KeyStore(handle.db, kek, { rotationIntervalSeconds: 30 * DAY, retirementGraceSeconds: DAY }, () => now);
    await store.ensureKeys();
  });
  afterEach(() => handle.close());

  const statuses = async () =>
    (await handle.db.select().from(signingKeys)).map((k) => `${k.alg}:${k.status}`).sort();

  it("bootstraps an active and a next key per algorithm, idempotently", async () => {
    await store.ensureKeys();
    expect(await statuses()).toEqual(["ES256:active", "ES256:next", "RS256:active", "RS256:next"]);
  });

  it("publishes next and active keys in the JWKS, without private material", async () => {
    const { keys } = await store.jwks();
    expect(keys).toHaveLength(4);
    for (const k of keys) {
      expect(k.d).toBeUndefined();
      expect(k.p).toBeUndefined();
      expect(k.use).toBe("sig");
      expect(k.kid).toBeTruthy();
    }
  });

  it("promotes next to active and keeps the old key published until its grace period ends", async () => {
    const before = await store.getActiveKey("RS256");
    const nextKid = (await handle.db.select().from(signingKeys)).find((k) => k.alg === "RS256" && k.status === "next")!.kid;
    const token = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "RS256", kid: before.kid })
      .setIssuer("iss")
      .setExpirationTime("1h")
      .sign(before.key);

    await store.rotate("RS256");
    expect((await store.getActiveKey("RS256")).kid).toBe(nextKid);
    // A token signed just before rotation still verifies.
    await expect(store.verify(token, { issuer: "iss" })).resolves.toMatchObject({ sub: "x" });
    expect(await statuses()).toContain("RS256:retiring");

    // After the grace period, the next rotation retires it and it leaves the JWKS.
    now = new Date(now.getTime() + 2 * DAY * 1000);
    await store.rotate("RS256");
    const published = (await store.jwks()).keys.map((k) => k.kid);
    expect(published).not.toContain(before.kid);
    await expect(store.verify(token, { issuer: "iss" })).rejects.toThrow();
  });

  it("rotates only when the active key is older than the interval", async () => {
    expect(await store.rotateIfDue()).toEqual([]);
    now = new Date(now.getTime() + 31 * DAY * 1000);
    expect((await store.rotateIfDue()).sort()).toEqual(["ES256", "RS256"]);
    expect(await store.rotateIfDue()).toEqual([]);
  });

  it("is safe when many instances rotate at once", async () => {
    now = new Date(now.getTime() + 31 * DAY * 1000);
    const instances = Array.from(
      { length: 5 },
      () => new KeyStore(handle.db, kek, { rotationIntervalSeconds: 30 * DAY, retirementGraceSeconds: DAY }, () => now),
    );
    const results = await Promise.all(instances.map((s) => s.rotateIfDue()));
    // The advisory lock serializes them: exactly one instance rotates each alg.
    expect(results.flat().sort()).toEqual(["ES256", "RS256"]);
    const all = await statuses();
    expect(all.filter((s) => s === "RS256:active")).toHaveLength(1);
    expect(all.filter((s) => s === "RS256:next")).toHaveLength(1);
  });

  it("stores private keys encrypted, readable only with the right KEK", async () => {
    const [row] = await handle.db.select().from(signingKeys);
    expect(row!.privateJwkEncrypted).not.toContain('"d"');
    const wrongKek = new KeyStore(handle.db, Buffer.alloc(32, 4), { rotationIntervalSeconds: DAY, retirementGraceSeconds: DAY });
    await expect(wrongKek.getActiveKey("RS256")).rejects.toThrow();
  });
});
