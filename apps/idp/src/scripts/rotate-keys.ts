/** Forces an immediate signing key rotation for every algorithm. */
import { connect } from "@kingdom-id/db";
import { loadConfig } from "../config.js";
import { KeyStore, SIGNING_ALGS } from "../keys/keystore.js";

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL, { max: 1 });
const store = new KeyStore(db, Buffer.from(config.KEY_ENCRYPTION_KEY, "base64"), {
  rotationIntervalSeconds: config.KEY_ROTATION_INTERVAL_SECONDS,
  retirementGraceSeconds: config.KEY_RETIREMENT_GRACE_SECONDS,
});
await store.ensureKeys();
for (const alg of SIGNING_ALGS) await store.rotate(alg);
console.log("rotated:", SIGNING_ALGS.join(", "));
console.log(JSON.stringify(await store.jwks(), null, 2));
await close();
