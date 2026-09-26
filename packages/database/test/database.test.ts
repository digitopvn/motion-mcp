import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FileRepository,
  generateApiKey,
  hashApiKey,
  isApiKeyFormat,
  pgSchema,
  verifyApiKey,
} from "../src/index.ts";

let dir: string;
let repo: FileRepository;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "db-"));
  repo = FileRepository.fromDataDir(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const newProject = (workspaceId = "ws_a") => ({
  workspaceId,
  title: "Launch film",
  brief: "30 second launch video",
  directorMode: "internal-opus" as const,
  artifacts: { projectDir: "workspaces/ws_a/projects/x" },
});

describe("FileRepository projects", () => {
  it("creates, reads, updates, lists and deletes", async () => {
    const created = await repo.projects.create(newProject());
    expect(created).toMatchObject({ status: "draft", irVersion: 0, workspaceId: "ws_a" });
    expect(created.id).toMatch(/^prj_/);
    expect(await repo.projects.get(created.id)).toEqual(created);

    const updated = await repo.projects.update(created.id, (p) => ({
      status: "ready",
      irVersion: p.irVersion + 1,
      artifacts: { ...p.artifacts, final: "renders/final.mp4" },
    }));
    expect(updated).toMatchObject({
      status: "ready",
      irVersion: 1,
      artifacts: { final: "renders/final.mp4" },
    });
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const other = await repo.projects.create(newProject("ws_b"));
    const second = await repo.projects.create(newProject());
    const listed = await repo.projects.list({ workspaceId: "ws_a" });
    expect(listed.map((p) => p.id)).toEqual([second.id, created.id]);
    expect(await repo.projects.list({ workspaceId: "ws_a", limit: 1 })).toHaveLength(1);

    expect(await repo.projects.delete(other.id)).toBe(true);
    expect(await repo.projects.delete(other.id)).toBe(false);
    expect(await repo.projects.get(other.id)).toBeUndefined();
  });

  it("rejects invalid records, immutable changes, unknown ids and traversal ids", async () => {
    const p = await repo.projects.create(newProject());
    await expect(repo.projects.update(p.id, { workspaceId: "ws_z" } as never)).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(repo.projects.update(p.id, { status: "bogus" as never })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(repo.projects.update("prj_missing", { title: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(repo.projects.get("../../etc/passwd")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(repo.projects.create({ ...newProject(), id: p.id })).rejects.toThrow(/already exists/);
    expect((await repo.projects.get(p.id))?.status).toBe("draft");
  });
});

describe("FileRepository jobs", () => {
  it("never loses concurrent updates to the same record", async () => {
    const job = await repo.jobs.create({ projectId: "prj_1", kind: "create" });
    expect(job).toMatchObject({ status: "queued", progress: { stage: "queued", pct: 0 } });
    await Promise.all(
      Array.from({ length: 40 }, () =>
        repo.jobs.update(job.id, (j) => ({ progress: { ...j.progress, pct: j.progress.pct + 1 } })),
      ),
    );
    expect((await repo.jobs.get(job.id))?.progress.pct).toBe(40);

    const files = await readdir(join(dir, "db", "jobs"));
    expect(files.filter((f) => !f.endsWith(".json"))).toEqual([]);
  });

  it("handles concurrent creates and filters by project and status", async () => {
    const jobs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repo.jobs.create({ projectId: i % 2 ? "prj_odd" : "prj_even", kind: "render" }),
      ),
    );
    expect(new Set(jobs.map((j) => j.id)).size).toBe(12);
    await repo.jobs.update(jobs[0]!.id, { status: "succeeded", result: { url: "x" } });
    expect(await repo.jobs.list({ projectId: "prj_even" })).toHaveLength(6);
    expect((await repo.jobs.list({ status: "succeeded" })).map((j) => j.id)).toEqual([jobs[0]!.id]);
  });
});

describe("FileRepository api keys, traces and usage", () => {
  it("stores only hashes and finds active keys", async () => {
    const generated = generateApiKey();
    const record = await repo.apiKeys.create({
      id: "key_1",
      workspaceId: "ws_a",
      name: "ci",
      hash: generated.hash,
      prefix: generated.prefix,
      createdAt: new Date().toISOString(),
    });
    expect(JSON.stringify(record)).not.toContain(generated.key);
    expect((await repo.apiKeys.findActiveByHash(hashApiKey(generated.key)))?.id).toBe("key_1");
    await repo.apiKeys.revoke("key_1");
    expect(await repo.apiKeys.findActiveByHash(generated.hash)).toBeUndefined();
    expect(await repo.apiKeys.listByWorkspace("ws_a")).toHaveLength(1);
  });

  it("saves traces and records usage in time order", async () => {
    await repo.traces.save({
      id: "0123456789abcdef0123456789abcdef",
      jobId: "job_1",
      name: "video.generate",
      root: { name: "video.generate" } as never,
      summary: { cogsUsd: 0.1 } as never,
      createdAt: new Date().toISOString(),
    });
    expect(await repo.traces.list({ jobId: "job_1" })).toHaveLength(1);

    await repo.usage.record({
      workspaceId: "ws_u",
      operation: "render_minute_hd",
      quantity: 0.5,
      credits: 13,
      byok: false,
      createdAt: "2026-09-26T10:00:00.000Z",
    });
    await repo.usage.record({
      workspaceId: "ws_u",
      operation: "api_call",
      quantity: 1,
      credits: 1,
      byok: false,
      createdAt: "2026-09-26T09:00:00.000Z",
    });
    const events = await repo.usage.list({ workspaceId: "ws_u" });
    expect(events.map((e) => e.operation)).toEqual(["api_call", "render_minute_hd"]);
    expect(await repo.usage.list({ workspaceId: "ws_u", since: "2026-09-26T09:30:00.000Z" })).toHaveLength(1);
  });

  it("persists across instances", async () => {
    const p = await repo.projects.create(newProject("ws_persist"));
    const reopened = FileRepository.fromDataDir(dir);
    expect((await reopened.projects.get(p.id))?.title).toBe("Launch film");
  });
});

describe("api key helpers", () => {
  it("generates mmcp_ keys and verifies them against the stored hash", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(isApiKeyFormat(a.key)).toBe(true);
    expect(a.prefix).toBe(a.key.slice(0, 12));
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyApiKey(a.key, a.hash)).toBe(true);
    expect(verifyApiKey(b.key, a.hash)).toBe(false);
    expect(verifyApiKey(a.key, "not-a-hash")).toBe(false);
    expect(verifyApiKey(`${a.key}x`, a.hash)).toBe(false);
  });
});

describe("postgres schema", () => {
  it("defines every production table", () => {
    const names = Object.values(pgSchema)
      .filter((v) => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v)
      .map((t) => getTableConfig(t as never).name)
      .sort();
    expect(names).toEqual(
      [
        "api_keys",
        "assets",
        "credit_ledger",
        "generation_jobs",
        "model_calls",
        "motion_ir_versions",
        "projects",
        "provider_credentials",
        "recipes",
        "renders",
        "scenes",
        "search_documents",
        "taste_packets",
        "taste_preferences",
        "traces",
        "usage_events",
        "users",
        "versions",
        "videos",
        "workspaces",
      ].sort(),
    );
    const search = getTableConfig(pgSchema.searchDocuments);
    expect(search.columns.map((c) => c.getSQLType())).toEqual(
      expect.arrayContaining(["tsvector", "vector(1536)"]),
    );
  });
});
