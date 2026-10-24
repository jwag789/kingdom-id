import { hash, verify } from "@node-rs/argon2";

// OWASP's argon2id baseline: 19 MiB memory, 2 iterations, 1 lane.
// Algorithm 2 is Argon2id (the package exposes it as an ambient const enum,
// which isolatedModules can't read).
const PARAMS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
// Long enough for any passphrase, short enough that argon2 input size isn't a DoS lever.
export const PASSWORD_MAX = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

// Verified against when the account doesn't exist, so "no such user" and
// "wrong password" take the same time.
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("kingdom-id-timing-equalizer");
  return dummy;
}
