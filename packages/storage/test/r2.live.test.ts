import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadDotEnv } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import { R2ArtifactStore } from "../src/index.ts";

loadDotEnv(resolve(import.meta.dirname, "../../../.env"));
const env = process.env;
const configured = Boolean(
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME,
);

describe.skipIf(!configured)("R2ArtifactStore (live)", () => {
  it("puts, reads, presigns, lists and deletes a tiny object under test/", async () => {
    const store = new R2ArtifactStore({
      accountId: env.R2_ACCOUNT_ID ?? "",
      accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
      bucket: env.R2_BUCKET_NAME ?? "",
    });
    const prefix = `test/live-${Date.now()}-${randomBytes(4).toString("hex")}/`;
    const key = `${prefix}hello.txt`;
    const body = Buffer.from("motion-mcp r2 live test");
    try {
      await store.put(key, body, "text/plain");
      expect(await store.exists(key)).toBe(true);
      expect((await store.get(key)).equals(body)).toBe(true);
      expect(await store.list(prefix)).toEqual([key]);
      const res = await fetch(await store.url(key, { expiresIn: 120 }));
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    } finally {
      await store.delete(key);
    }
    expect(await store.exists(key)).toBe(false);
    store.destroy();
  });
});
