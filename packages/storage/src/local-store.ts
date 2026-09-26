import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { MotionError } from "@motion-mcp/shared";
import {
  type ArtifactBody,
  type ArtifactStore,
  assertContentType,
  assertExpiry,
  assertSafeKey,
  assertSafePrefix,
  type PutResult,
} from "./artifact-store.ts";

const TEMP_SUFFIX = ".tmp-upload";

/**
 * Filesystem store under `<DATA_DIR>/artifacts`. Writes are atomic (temp file + rename) and every key is
 * validated and re-checked against the root after resolution, so no key can escape the directory.
 * `url()` returns `<publicBaseUrl>/<key>` when a base URL is configured (the server serves the files),
 * otherwise a `file://` URL; local URLs do not expire.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly driver = "local" as const;
  readonly root: string;
  private readonly publicBaseUrl?: string;

  constructor(options: { root: string; publicBaseUrl?: string }) {
    this.root = resolve(options.root);
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, "");
  }

  static fromDataDir(dataDir: string, publicBaseUrl?: string): LocalArtifactStore {
    return new LocalArtifactStore({ root: join(dataDir, "artifacts"), publicBaseUrl });
  }

  async put(key: string, body: ArtifactBody, contentType: string): Promise<PutResult> {
    const target = this.pathFor(key);
    assertContentType(contentType);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`;
    try {
      if (body instanceof Uint8Array) await writeFile(temp, body);
      else await copyFile(body.path, temp);
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && !(body instanceof Uint8Array)) {
        throw new MotionError("NOT_FOUND", "Source file for artifact upload does not exist", { cause: err });
      }
      throw err;
    }
    const { size } = await stat(target);
    return { key, size, contentType };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR")
        throw new MotionError("NOT_FOUND", `Artifact not found: ${key}`);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async url(key: string, options: { expiresIn?: number } = {}): Promise<string> {
    assertExpiry(options.expiresIn);
    const path = this.pathFor(key);
    if (this.publicBaseUrl)
      return `${this.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
    return pathToFileURL(path).href;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    assertSafePrefix(prefix);
    const slash = prefix.lastIndexOf("/");
    const baseDir = slash >= 0 ? prefix.slice(0, slash) : "";
    const start = baseDir ? this.pathFor(baseDir) : this.root;
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw err;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && !entry.name.endsWith(TEMP_SUFFIX)) {
          const key = relative(this.root, full).split(sep).join("/");
          if (key.startsWith(prefix)) keys.push(key);
        }
      }
    };
    await walk(start);
    return keys.sort();
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(this.root, ...key.split("/"));
    const rel = relative(this.root, full);
    if (rel === "" || rel.startsWith("..") || resolve(this.root, rel) !== full) {
      throw new MotionError("VALIDATION", "Artifact key escapes the storage root");
    }
    return full;
  }
}
