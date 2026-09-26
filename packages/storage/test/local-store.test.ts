import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  artifactKey,
  assertSafeKey,
  createArtifactStore,
  LocalArtifactStore,
  projectPrefix,
  R2ArtifactStore,
} from "../src/index.ts";

let dir: string;
let store: LocalArtifactStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "artifacts-"));
  store = new LocalArtifactStore({ root: join(dir, "artifacts") });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("key layout", () => {
  it("builds canonical project keys", () => {
    expect(projectPrefix("ws_1", "prj_2")).toBe("workspaces/ws_1/projects/prj_2/");
    expect(
      artifactKey({ workspaceId: "ws_1", projectId: "prj_2", kind: "renders", name: "final/v1.mp4" }),
    ).toBe("workspaces/ws_1/projects/prj_2/renders/final/v1.mp4");
    expect(() =>
      artifactKey({ workspaceId: "ws_1", projectId: "..", kind: "renders", name: "a.mp4" }),
    ).toThrow();
    expect(() =>
      artifactKey({ workspaceId: "ws_1", projectId: "p", kind: "secrets" as never, name: "a.mp4" }),
    ).toThrow(/kind/);
  });

  it.each([
    "../escape.txt",
    "a/../../escape.txt",
    "/etc/passwd",
    "a//b",
    "a/./b",
    "C:/Windows/win.ini",
    "a\\..\\b",
    ".hidden",
    "a/",
    "",
    "x".repeat(600),
  ])("rejects unsafe key %j", (key) => {
    expect(() => assertSafeKey(key)).toThrow();
  });
});

describe("LocalArtifactStore", () => {
  it("round-trips bytes and files, lists by prefix and deletes", async () => {
    const key = artifactKey({ workspaceId: "ws1", projectId: "p1", kind: "snapshots", name: "s01.png" });
    const bytes = Buffer.from("hello artifact");
    expect(await store.exists(key)).toBe(false);
    await expect(store.get(key)).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await store.put(key, bytes, "image/png")).toEqual({
      key,
      size: bytes.length,
      contentType: "image/png",
    });
    expect(await store.exists(key)).toBe(true);
    expect((await store.get(key)).equals(bytes)).toBe(true);

    const src = join(dir, "source.mp4");
    await writeFile(src, Buffer.alloc(2048, 7));
    const renderKey = artifactKey({
      workspaceId: "ws1",
      projectId: "p1",
      kind: "renders",
      name: "final.mp4",
    });
    expect((await store.put(renderKey, { path: src }, "video/mp4")).size).toBe(2048);
    await expect(
      store.put("x/missing.mp4", { path: join(dir, "nope.mp4") }, "video/mp4"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await store.put("workspaces/ws2/projects/p9/assets/a.txt", Buffer.from("x"), "text/plain");
    expect(await store.list("workspaces/ws1/")).toEqual([renderKey, key]);
    expect(await store.list("workspaces/ws1/projects/p1/ren")).toEqual([renderKey]);
    expect(await store.list("workspaces/nobody/")).toEqual([]);

    expect(await store.url(key)).toMatch(/^file:\/\//);
    await store.delete(key);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);

    const leftovers = await readdir(join(dir, "artifacts/workspaces/ws1/projects/p1/renders"));
    expect(leftovers).toEqual(["final.mp4"]);
  });

  it("rejects traversal on every operation", async () => {
    const bad = "../outside.txt";
    await expect(store.put(bad, Buffer.from("x"), "text/plain")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(store.get(bad)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.exists("a/../../b")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.delete("..")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.url("/abs")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.list("../")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await readdir(dir)).not.toContain("outside.txt");
  });

  it("validates content types and URL expiry, and builds public URLs when configured", async () => {
    const pub = new LocalArtifactStore({
      root: join(dir, "artifacts"),
      publicBaseUrl: "https://app.example/files/",
    });
    await expect(pub.put("k/a.txt", Buffer.from("x"), "not a type")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await pub.url("k/a b.txt".replace(" ", "_"))).toBe("https://app.example/files/k/a_b.txt");
    await expect(pub.url("k/a.txt", { expiresIn: 0 })).rejects.toThrow(/expiresIn/);
  });
});

describe("createArtifactStore", () => {
  it("selects the configured driver and validates R2 settings without network access", () => {
    expect(createArtifactStore({ STORAGE_DRIVER: "local", DATA_DIR: dir }).driver).toBe("local");
    expect(() => createArtifactStore({ STORAGE_DRIVER: "r2", DATA_DIR: dir })).toThrow(/R2 accountId/);
    const r2 = new R2ArtifactStore({
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      bucket: "bucket",
    });
    expect(r2.driver).toBe("r2");
    r2.destroy();
  });

  it("presigns URLs locally with the requested expiry", async () => {
    const r2 = new R2ArtifactStore({
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      bucket: "bucket",
    });
    const url = new URL(await r2.url("workspaces/w/projects/p/renders/a.mp4", { expiresIn: 600 }));
    expect(url.host).toBe("bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    r2.destroy();
  });
});
