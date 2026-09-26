import type { MotionConfig } from "@motion-mcp/shared";
import { MotionError } from "@motion-mcp/shared";
import type { ArtifactStore } from "./artifact-store.ts";
import { LocalArtifactStore } from "./local-store.ts";
import { R2ArtifactStore } from "./r2-store.ts";

export * from "./artifact-store.ts";
export * from "./local-store.ts";
export * from "./r2-store.ts";

/**
 * Build the store selected by `STORAGE_DRIVER`. For the local driver, pass `localPublicBaseUrl` when the
 * HTTP server serves the artifacts directory; otherwise local URLs are `file://` URLs.
 */
export function createArtifactStore(
  config: Pick<
    MotionConfig,
    | "STORAGE_DRIVER"
    | "DATA_DIR"
    | "R2_ACCOUNT_ID"
    | "R2_ACCESS_KEY_ID"
    | "R2_SECRET_ACCESS_KEY"
    | "R2_BUCKET_NAME"
  >,
  options: { localPublicBaseUrl?: string } = {},
): ArtifactStore {
  if (config.STORAGE_DRIVER === "local") {
    return LocalArtifactStore.fromDataDir(config.DATA_DIR, options.localPublicBaseUrl);
  }
  if (config.STORAGE_DRIVER === "r2") {
    return new R2ArtifactStore({
      accountId: config.R2_ACCOUNT_ID ?? "",
      accessKeyId: config.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: config.R2_SECRET_ACCESS_KEY ?? "",
      bucket: config.R2_BUCKET_NAME ?? "",
    });
  }
  throw new MotionError("CONFIG", `Unknown STORAGE_DRIVER ${String(config.STORAGE_DRIVER)}`);
}
