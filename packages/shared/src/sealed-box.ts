import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { MotionError } from "./errors.ts";

export interface Sealed {
  /** base64 of AES-256-GCM ciphertext followed by its 16-byte auth tag. */
  ciphertext: string;
  /** base64 of the 12-byte nonce. */
  nonce: string;
  /** Which master key sealed it (first 16 hex of the key's sha256), for rotation. */
  keyId: string;
}

/** Parses a 32-byte key given as 64 hex characters or base64. */
export function parseMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new MotionError("CONFIG", "CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
  }
  return key;
}

/**
 * Authenticated encryption for values stored at rest (AES-256-GCM, random nonce per value). The
 * additional data binds a ciphertext to its record, so a sealed value copied onto another record fails.
 */
export class SealedBox {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(masterKey: string | Buffer) {
    this.key = typeof masterKey === "string" ? parseMasterKey(masterKey) : masterKey;
    if (this.key.length !== 32) throw new MotionError("CONFIG", "Master key must be 32 bytes");
    this.keyId = createHash("sha256").update(this.key).digest("hex").slice(0, 16);
  }

  seal(plaintext: string, aad: string): Sealed {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext: body.toString("base64"), nonce: nonce.toString("base64"), keyId: this.keyId };
  }

  open(sealed: Sealed, aad: string): string {
    if (sealed.keyId !== this.keyId) {
      throw new MotionError("CONFIG", "Stored value was sealed with a different CREDENTIALS_ENCRYPTION_KEY");
    }
    const body = Buffer.from(sealed.ciphertext, "base64");
    if (body.length < 16) throw new MotionError("INTERNAL", "Sealed value is truncated");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.nonce, "base64"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString(
        "utf8",
      );
    } catch (err) {
      throw new MotionError("INTERNAL", "Sealed value failed authentication", { cause: err });
    }
  }
}
