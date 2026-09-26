import { MotionError } from "@motion-mcp/shared";

/** A file on disk to upload, or bytes already in memory. */
export type ArtifactBody = Uint8Array | { path: string };

export interface PutResult {
  key: string;
  size: number;
  contentType: string;
}

/** Storage for large binaries (renders, snapshots, assets, compositions). Keys are validated `/`-paths. */
export interface ArtifactStore {
  readonly driver: "local" | "r2";
  put(key: string, body: ArtifactBody, contentType: string): Promise<PutResult>;
  /** Throws NOT_FOUND when the key does not exist. */
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** A URL a client can fetch. Remote stores sign it for `expiresIn` seconds. */
  url(key: string, options?: { expiresIn?: number }): Promise<string>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Keys under `prefix` (a key prefix, not necessarily ending in `/`), sorted. */
  list(prefix: string): Promise<string[]>;
}

export const DEFAULT_URL_EXPIRY_SECONDS = 3600;
export const MAX_URL_EXPIRY_SECONDS = 7 * 24 * 3600;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Keys are `/`-separated segments of `[A-Za-z0-9._-]` that start with an alphanumeric, so `.`/`..`,
 * absolute paths, backslashes, drive letters and empty segments are all impossible by construction.
 */
export function assertSafeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new MotionError("VALIDATION", "Invalid artifact key length");
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new MotionError("VALIDATION", "Invalid artifact key", { details: { key: key.slice(0, 200) } });
    }
  }
  return key;
}

/** Prefixes may be empty or end in `/`; every complete segment must be safe. */
export function assertSafePrefix(prefix: string): string {
  if (prefix === "") return prefix;
  assertSafeKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
  return prefix;
}

export function assertContentType(contentType: string): string {
  if (!/^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(contentType) || contentType.length > 200) {
    throw new MotionError("VALIDATION", "Invalid content type");
  }
  return contentType;
}

export function assertExpiry(expiresIn: number | undefined): number {
  const value = expiresIn ?? DEFAULT_URL_EXPIRY_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_URL_EXPIRY_SECONDS) {
    throw new MotionError(
      "VALIDATION",
      `expiresIn must be an integer between 1 and ${MAX_URL_EXPIRY_SECONDS}`,
    );
  }
  return value;
}

export const ARTIFACT_KINDS = ["renders", "snapshots", "assets", "compositions"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Canonical prefix for one project: `workspaces/<ws>/projects/<project>/`. */
export function projectPrefix(workspaceId: string, projectId: string): string {
  return `workspaces/${assertSafeKey(workspaceId)}/projects/${assertSafeKey(projectId)}/`;
}

/** `workspaces/<ws>/projects/<project>/<kind>/<name...>`; `name` may contain `/` sub-paths. */
export function artifactKey(input: {
  workspaceId: string;
  projectId: string;
  kind: ArtifactKind;
  name: string;
}): string {
  if (!ARTIFACT_KINDS.includes(input.kind))
    throw new MotionError("VALIDATION", `Unknown artifact kind ${input.kind}`);
  return assertSafeKey(
    `${projectPrefix(input.workspaceId, input.projectId)}${input.kind}/${assertSafeKey(input.name)}`,
  );
}
