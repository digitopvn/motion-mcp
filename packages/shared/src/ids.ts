import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Sortable, URL-safe id: `<prefix>_<time36><random>`. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const bytes = randomBytes(10);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${time}${rand}`;
}

export function isSafeId(id: string): boolean {
  return /^[a-z]+_[0-9a-z]{10,40}$/.test(id);
}
