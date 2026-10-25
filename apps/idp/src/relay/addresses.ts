import { randomInt } from "node:crypto";

// Readable, but with enough randomness that addresses can't be guessed:
// 64 × 64 × 32⁶ ≈ 4.4 × 10¹² per domain.
const ADJECTIVES = [
  "amber", "ashen", "azure", "bold", "brave", "bright", "calm", "clever", "cobalt", "coral", "crimson", "crisp",
  "dawn", "deep", "eager", "early", "fair", "fierce", "gentle", "gilded", "golden", "grand", "green", "hidden",
  "honest", "ivory", "jade", "keen", "kind", "lively", "loyal", "lucky", "lunar", "merry", "misty", "noble",
  "olive", "pearl", "plain", "proud", "quiet", "rapid", "royal", "ruby", "rustic", "sable", "scarlet", "silver",
  "sleek", "solar", "steady", "stone", "stormy", "sunny", "swift", "tidy", "true", "valiant", "velvet", "vivid",
  "warm", "wild", "wise", "young",
];
const NOUNS = [
  "anchor", "arrow", "badger", "banner", "beacon", "bear", "bishop", "bridge", "castle", "cedar", "comet", "crown",
  "dragon", "eagle", "ember", "falcon", "fern", "forge", "fox", "garden", "gate", "griffin", "harbor", "hawk",
  "heron", "keep", "knight", "lantern", "lark", "lion", "lotus", "manor", "maple", "meadow", "moat", "oak",
  "orchard", "otter", "owl", "pine", "quill", "raven", "realm", "river", "rook", "sage", "scroll", "shield",
  "sparrow", "spire", "stag", "star", "summit", "sword", "thistle", "tower", "valley", "vault", "willow", "wolf",
  "wren", "yew", "zephyr", "harp",
];
const BASE32 = "abcdefghijkmnpqrstuvwxyz23456789";

const pick = <T>(list: readonly T[]) => list[randomInt(list.length)]!;
const suffix = (n: number) => Array.from({ length: n }, () => BASE32[randomInt(BASE32.length)]).join("");

/** A mask address, e.g. `quiet-falcon.k3m9q2@relay.kingdomwebbuilders.com`. */
export const newMaskAddress = (domain: string) => `${pick(ADJECTIVES)}-${pick(NOUNS)}.${suffix(6)}@${domain}`;

/** A reverse alias, e.g. `r.8fk2m9q4hx7c3pza@relay.kingdomwebbuilders.com`. Never shown as anyone's identity. */
export const newReverseAlias = (domain: string) => `r.${suffix(16)}@${domain}`;

export const normalizeAddress = (address: string) => address.trim().toLowerCase();

export const isOnDomain = (address: string, domain: string) => normalizeAddress(address).endsWith(`@${domain.toLowerCase()}`);
