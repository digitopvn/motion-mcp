import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const API_KEY_PREFIX = "mmcp_";
const KEY_PATTERN = /^mmcp_[A-Za-z0-9_-]{43}$/;

export interface GeneratedApiKey {
  /** Plaintext key. Show it to the user once; never persist or log it. */
  key: string;
  /** sha256 hex, the only form that is stored. */
  hash: string;
  /** Non-secret display prefix for listing keys. */
  prefix: string;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function isApiKeyFormat(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** `mmcp_` + 32 random bytes (base64url, 256 bits of entropy). */
export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}

/** Constant-time comparison of a presented key against a stored sha256 hex hash. */
export function verifyApiKey(presented: string, storedHash: string): boolean {
  if (typeof presented !== "string" || typeof storedHash !== "string") return false;
  if (!/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const actual = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(actual, Buffer.from(storedHash, "hex"));
}
