import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger, MotionConfig } from "@motion-mcp/shared";
import { type ArtifactStore, assertSafeKey, MAX_URL_EXPIRY_SECONDS } from "@motion-mcp/storage";

/** Default lifetime of artifact URLs handed to MCP callers. */
export const ARTIFACT_URL_TTL_SECONDS = 3600;
/** Route prefix the HTTP app serves local artifacts under. */
export const ARTIFACT_ROUTE = "/artifacts";

const DEV_SIGNING_SECRET = "motion-mcp-development-artifact-signing-secret";

/**
 * Resolve the HMAC secret for local artifact URLs: the explicit key, else a stable derivation from
 * MOTION_API_KEYS, else (development/test only) a fixed value. Production without either gets a random
 * per-process secret, so URLs stay unforgeable but stop working after a restart.
 */
export function resolveSigningSecret(
  config: Pick<MotionConfig, "ARTIFACT_SIGNING_SECRET" | "MOTION_API_KEYS" | "NODE_ENV">,
  logger?: Logger,
): string {
  if (config.ARTIFACT_SIGNING_SECRET) return config.ARTIFACT_SIGNING_SECRET;
  if (config.MOTION_API_KEYS.trim()) {
    return createHash("sha256").update(`motion-artifacts\n${config.MOTION_API_KEYS}`).digest("hex");
  }
  if (config.NODE_ENV !== "production") {
    logger?.warn("artifacts.signing_secret.dev", {
      detail: "ARTIFACT_SIGNING_SECRET and MOTION_API_KEYS are unset; using the fixed development secret",
    });
    return DEV_SIGNING_SECRET;
  }
  logger?.warn("artifacts.signing_secret.ephemeral", {
    detail: "ARTIFACT_SIGNING_SECRET is unset; using a per-process secret (URLs expire on restart)",
  });
  return randomBytes(32).toString("hex");
}

export class ArtifactSigner {
  constructor(
    private readonly secret: string,
    private readonly baseUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  private signature(key: string, exp: number): Buffer {
    return createHmac("sha256", this.secret).update(`${key}\n${exp}`).digest();
  }

  /** `${baseUrl}/artifacts/<key>?exp=<unix seconds>&sig=<base64url hmac>` */
  sign(key: string, expiresIn = ARTIFACT_URL_TTL_SECONDS): string {
    assertSafeKey(key);
    const ttl = Math.min(Math.max(1, Math.floor(expiresIn)), MAX_URL_EXPIRY_SECONDS);
    const exp = Math.floor(this.now() / 1000) + ttl;
    const sig = this.signature(key, exp).toString("base64url");
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `${this.baseUrl.replace(/\/+$/, "")}${ARTIFACT_ROUTE}/${path}?exp=${exp}&sig=${sig}`;
  }

  /** Constant-time check of a presented signature; false when expired, malformed or too far in the future. */
  verify(key: string, exp: unknown, sig: unknown): boolean {
    if (typeof exp !== "string" || typeof sig !== "string" || !/^\d{1,12}$/.test(exp)) return false;
    const expiry = Number(exp);
    const nowSeconds = Math.floor(this.now() / 1000);
    if (expiry < nowSeconds || expiry - nowSeconds > MAX_URL_EXPIRY_SECONDS) return false;
    let presented: Buffer;
    try {
      assertSafeKey(key);
      presented = Buffer.from(sig, "base64url");
    } catch {
      return false;
    }
    const expected = this.signature(key, expiry);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }
}

/** Client-facing URL for a stored artifact: HMAC-signed app route for local storage, presigned for R2. */
export type ArtifactUrlFn = (key: string, expiresIn?: number) => Promise<string>;

export function artifactUrlFn(store: ArtifactStore, signer: ArtifactSigner): ArtifactUrlFn {
  return async (key, expiresIn = ARTIFACT_URL_TTL_SECONDS) =>
    store.driver === "local" ? signer.sign(key, expiresIn) : store.url(key, { expiresIn });
}
