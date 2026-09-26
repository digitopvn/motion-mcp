import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_PACK_DIR,
  DomainPack,
  KNOWLEDGE_FILES,
  KnowledgeFile,
  loadDomainPack,
} from "../src/index.ts";

let pack: DomainPack;
const entriesById = new Map<string, KnowledgeFile["entries"][number]>();

beforeAll(async () => {
  pack = await loadDomainPack();
  for (const kind of KNOWLEDGE_FILES) {
    const file = KnowledgeFile.parse(parse(await readFile(join(DEFAULT_PACK_DIR, `${kind}.yaml`), "utf8")));
    for (const e of file.entries) entriesById.set(`${kind}/${e.id}`, e);
  }
});

describe("pack files", () => {
  it("every authored YAML entry passes the schema and stays within 240 chars", async () => {
    for (const kind of KNOWLEDGE_FILES) {
      const raw = parse(await readFile(join(DEFAULT_PACK_DIR, `${kind}.yaml`), "utf8"));
      const result = KnowledgeFile.safeParse(raw);
      expect(result.success, `${kind}: ${result.error?.message}`).toBe(true);
      expect(result.data?.kind).toBe(kind);
      for (const e of result.data?.entries ?? []) expect(e.text.length).toBeLessThanOrEqual(240);
    }
    const counts = pack.entryCounts();
    for (const kind of KNOWLEDGE_FILES) expect(counts[kind]).toBeGreaterThan(5);
  });

  it("loads all vendored profiles and keeps the license and notice", async () => {
    expect(pack.styleIndex({ excludeBrandInspired: false })).toHaveLength(61);
    expect(pack.getStyleProfile("glass-keynote")?.dimensions).toHaveProperty("palette");
    const license = await readFile(join(DEFAULT_PACK_DIR, "LICENSE-ak-motion-video.txt"), "utf8");
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/BestAgentKits/);
    const notice = await readFile(join(DEFAULT_PACK_DIR, "NOTICE"), "utf8");
    expect(notice).toMatch(/bestagentkits\/motion-video-skill/);
  });

  it("caches the parsed pack", async () => {
    expect(await loadDomainPack()).toBe(pack);
    const fresh = new DomainPack();
    expect(() => fresh.retrieve({ role: "worker" })).toThrow(/load/);
    await Promise.all([fresh.load(), fresh.load()]);
    expect(fresh.loaded).toBe(true);
  });

  it("fails loudly on an invalid pack directory", async () => {
    await expect(new DomainPack({ packDir: join(DEFAULT_PACK_DIR, "missing") }).load()).rejects.toMatchObject(
      {
        code: "CONFIG",
      },
    );
  });
});

describe("retrieve", () => {
  it("returns only entries whose tags match the query", () => {
    const result = pack.retrieve({
      role: "worker",
      sceneRole: "hook",
      format: "16:9",
      energy: 2,
      styleIds: ["glass-keynote"],
      step: "compose",
      limit: 100,
      maxChars: 50_000,
    });
    expect(result.snippets.length).toBeGreaterThan(0);
    for (const s of result.snippets) {
      const t = entriesById.get(s.id)?.tags;
      expect(t, s.id).toBeDefined();
      if (!t) continue;
      expect(["worker", "both"]).toContain(t.role);
      expect(["compose", "any"]).toContain(t.pipeline_step);
      if (t.invariant) continue;
      if (t.scene_types.length) expect(t.scene_types).toContain("hook");
      if (t.format.length) expect(t.format).toContain("16:9");
      if (t.energy.length) expect(t.energy).toContain(2);
      if (t.styles.length) expect(t.styles).toContain("glass-keynote");
    }
    expect(result.snippets.some((s) => s.id === "shot-patterns/hook-single-statement")).toBe(true);
    expect(result.snippets.some((s) => s.id === "shot-patterns/cta-end-card")).toBe(false);
    expect(result.snippets.some((s) => s.id === "principles/narrative-arc")).toBe(false);
  });

  it("always includes step- and role-matching invariants first, regardless of other facets", () => {
    const workerInvariants = [...entriesById.entries()].filter(
      ([, e]) => e.tags.invariant && e.tags.role !== "director",
    );
    const expected = workerInvariants
      .filter(([, e]) => e.tags.pipeline_step === "audio" || e.tags.pipeline_step === "any")
      .map(([id]) => id);
    expect(expected.length).toBeGreaterThan(0);
    const result = pack.retrieve({
      role: "worker",
      sceneRole: "cta",
      format: "9:16",
      energy: 5,
      styleIds: ["neon-cyberpunk"],
      step: "audio",
      limit: 100,
      maxChars: 50_000,
    });
    const invariantIds = result.snippets.filter((s) => s.invariant).map((s) => s.id);
    expect(invariantIds.sort()).toEqual([...expected].sort());
    const firstNonInvariant = result.snippets.findIndex((s) => !s.invariant);
    expect(firstNonInvariant).toBeGreaterThan(0);
    expect(result.snippets.slice(firstNonInvariant).every((s) => !s.invariant)).toBe(true);

    const unscoped = pack.retrieve({ role: "worker", sceneRole: "cta", limit: 100, maxChars: 50_000 });
    for (const [id] of workerInvariants) expect(unscoped.snippets.map((s) => s.id)).toContain(id);
  });

  it("leaves room for scene-specific guidance within the default budget", () => {
    const result = pack.retrieve({ role: "worker", sceneRole: "evidence", step: "compose" });
    expect(result.text.length).toBeLessThanOrEqual(3000);
    expect(result.snippets.some((s) => s.invariant)).toBe(true);
    expect(result.snippets.some((s) => !s.invariant && s.score > 0)).toBe(true);
  });

  it("ranks explicit tag matches above wildcard entries", () => {
    const result = pack.retrieve({ role: "director", sceneRole: "hook", limit: 100, maxChars: 50_000 });
    const scored = result.snippets.filter((s) => !s.invariant);
    expect(scored[0]?.score).toBeGreaterThan(0);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.score).toBeGreaterThanOrEqual(scored[i]!.score);
    }
  });

  it("enforces limit and maxChars", () => {
    const small = pack.retrieve({ role: "worker", limit: 3, maxChars: 50_000 });
    expect(small.snippets).toHaveLength(3);
    expect(small.truncated).toBe(true);
    for (const maxChars of [120, 500, 1500]) {
      const r = pack.retrieve({ role: "worker", limit: 100, maxChars });
      expect(r.text.length).toBeLessThanOrEqual(maxChars);
      expect(r.text.split("\n")).toHaveLength(r.snippets.length);
    }
  });

  it("filters by knowledge kind", () => {
    const r = pack.retrieve({ role: "director", kinds: ["quality-rubric"], limit: 100, maxChars: 50_000 });
    expect(r.snippets.length).toBeGreaterThan(0);
    expect(r.snippets.every((s) => s.kind === "quality-rubric")).toBe(true);
  });

  it("rejects invalid queries at the boundary", () => {
    expect(() => pack.retrieve({ role: "worker", sceneRole: "intro" as never })).toThrow();
    expect(() => pack.retrieve({ role: "worker", limit: 0 })).toThrow();
  });
});

describe("styles", () => {
  it("excludes brand-inspired styles by default", () => {
    const all = pack.styleIndex({ excludeBrandInspired: false });
    const safe = pack.styleIndex();
    expect(all.filter((s) => s.brandInspired)).toHaveLength(39);
    expect(safe).toHaveLength(22);
    expect(safe.some((s) => s.id === "cinematic-product-launch")).toBe(false);
    const text = pack.styleIndexText({ maxChars: 1000 });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).not.toMatch(/cinematic-product-launch/);
  });

  it("finds styles by id, alias and keywords", () => {
    expect(pack.findStyles("kinetic typography")[0]?.id).toBe("kinetic-typography");
    expect(pack.findStyles("blueprint")[0]?.id).toBe("blueprint-engineering");
    expect(pack.findStyles("apple-like").some((s) => s.id === "cinematic-product-launch")).toBe(false);
    expect(pack.findStyles("apple-like", { includeBrandInspired: true })[0]?.id).toBe(
      "cinematic-product-launch",
    );
    expect(pack.findStyles("   ")).toEqual([]);
  });
});
