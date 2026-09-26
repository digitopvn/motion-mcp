import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MotionIR, MotionScene } from "@motion-mcp/motion-ir";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, GSAP_ASSET, ROOT_COMPOSITION_ID } from "../src/compile.ts";
import { formatMetric, tokenizeCode } from "../src/elements.ts";
import { resolveBeats } from "../src/timing.ts";
import { GSAP_EASE } from "../src/tokens.ts";
import { escapeHtml } from "../src/util.ts";
import { GOLDEN_FIXTURES, goldenIr, shortIr, tempDir } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

async function compileInto(ir: MotionIR, label: string) {
  const t = await tempDir(label);
  cleanups.push(t.cleanup);
  return compileProject(ir, t.dir);
}

const FORBIDDEN: [string, RegExp][] = [
  ["Date", /\bDate\s*[.(]|new Date\b/],
  ["requestAnimationFrame", /requestAnimationFrame/],
  ["Math.random", /Math\.random/],
  ["infinite repeat", /repeat["']?\s*:\s*-1/],
  ["CSS @keyframes", /@keyframes/],
  ["CSS animation", /(^|[\s;{])animation(-name)?\s*:/m],
  ["CSS transition", /(^|[\s;{])transition\s*:/m],
  ["setTimeout/setInterval", /set(Timeout|Interval)\s*\(/],
];

describe.each(GOLDEN_FIXTURES)("compileProject(%s)", (name) => {
  const ir = goldenIr(name);

  it("writes a well-formed HyperFrames project", async () => {
    const project = await compileInto(ir, name);
    const total = ir.scenes.reduce((s, sc) => s + sc.duration, 0);
    expect(project.compositionId).toBe(ROOT_COMPOSITION_ID);
    expect(project.duration).toBeCloseTo(total, 6);
    expect(project.files).toEqual([...project.files].sort());
    for (const f of ["index.html", "hyperframes.json", "motion-ir.json", GSAP_ASSET]) {
      expect(project.files).toContain(f);
    }

    const index = await readFile(join(project.projectDir, "index.html"), "utf8");
    expect(index).toContain(`data-composition-id="${ROOT_COMPOSITION_ID}"`);
    expect(index).toContain(`data-width="${ir.format.width}"`);
    expect(index).toContain(`data-height="${ir.format.height}"`);
    expect(index).toContain(`src="${GSAP_ASSET}"`);
    expect(index).toMatch(/tl\.set\(\{\}, \{\}, [\d.]+\)/);
    expect(index).not.toMatch(/https?:\/\//);

    const compositions = (await readdir(join(project.projectDir, "compositions"))).sort();
    expect(compositions).toEqual(ir.scenes.map((s) => `${s.id}.html`).sort());

    let start = 0;
    for (const scene of ir.scenes) {
      const host = index.match(new RegExp(`<div id="scene-${scene.id}"[^>]*>`))?.[0] ?? "";
      expect(host).toContain(`data-composition-src="compositions/${scene.id}.html"`);
      expect(host).toContain(`data-start="${Number(start.toFixed(3))}"`);
      expect(host).toContain(`data-duration="${scene.duration}"`);
      expect(project.sceneStarts[scene.id]).toBeCloseTo(start, 6);
      start += scene.duration;

      const html = await readFile(join(project.projectDir, "compositions", `${scene.id}.html`), "utf8");
      expect(html.trimStart().startsWith("<template")).toBe(true);
      expect(html).toContain(`data-composition-id="${scene.id}"`);
      expect(html).toContain("gsap.timeline({ paused: true })");
      expect(html).toContain(`window.__timelines["${scene.id}"] = tl;`);
      expect(html).toContain(`tl.set({}, {}, ${scene.duration});`);
      expect(html).toContain("@font-face");
      for (const el of scene.elements) expect(html).toContain(`id="m-${scene.id}__el-${el.id}"`);
      for (const [label, re] of FORBIDDEN) {
        expect(re.test(html), `${scene.id} uses ${label}`).toBe(false);
      }
    }
    for (const [label, re] of FORBIDDEN) expect(re.test(index), `index uses ${label}`).toBe(false);

    const irJson = JSON.parse(await readFile(join(project.projectDir, "motion-ir.json"), "utf8"));
    expect(irJson.id).toBe(ir.id);
  });

  it("is deterministic (byte-identical output across compiles)", async () => {
    const a = await compileInto(ir, `${name}-a`);
    const b = await compileInto(ir, `${name}-b`);
    expect(b.files).toEqual(a.files);
    for (const f of a.files) {
      const [x, y] = await Promise.all([readFile(join(a.projectDir, f)), readFile(join(b.projectDir, f))]);
      expect(x.equals(y), `${f} differs`).toBe(true);
    }
  });
});

describe("compileProject safety", () => {
  it("HTML-escapes user text", async () => {
    const ir = shortIr();
    const scene = ir.scenes[0] as MotionScene;
    const el = scene.elements.find((e) => e.kind === "text");
    if (el?.kind !== "text") throw new Error("fixture has no text element");
    el.text = `<script>alert("x")</script> & 'q'`;
    const project = await compileInto(ir, "escape");
    const html = await readFile(join(project.projectDir, "compositions", `${scene.id}.html`), "utf8");
    expect(html).not.toContain("<script>alert");
    expect(html).toMatch(/&lt;|<span class="(w|ch)">&lt;<\/span>/);
  });

  it("rejects an invalid IR with a VALIDATION error", async () => {
    const t = await tempDir("invalid");
    cleanups.push(t.cleanup);
    await expect(compileProject({ scenes: [] } as unknown as MotionIR, t.dir)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("rejects asset mappings outside assets/ or https", async () => {
    const t = await tempDir("assets");
    cleanups.push(t.cleanup);
    await expect(
      compileProject(shortIr(), t.dir, { assets: { logo: "../../etc/passwd" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("timing and tokens", () => {
  const scene = (choreography: MotionScene["choreography"]) =>
    ({
      id: "s",
      duration: 5,
      elements: ["a", "b", "c"].map((id) => ({ id })),
      choreography,
    }) as unknown as Pick<MotionScene, "id" | "duration" | "choreography" | "elements">;
  const beat = (target: string, at: MotionScene["choreography"][number]["at"], duration = 1) =>
    ({ target, primitive: "fade-in", at, duration }) as MotionScene["choreography"][number];

  it("resolves numeric, after and with timing", () => {
    const r = resolveBeats(
      scene([beat("a", 0.5), beat("b", { after: "a", offset: 0.25 }), beat("c", { with: "b", offset: 0.1 })]),
    );
    expect(r.map((x) => x.start)).toEqual([0.5, 1.75, 1.85]);
  });

  it("reads references in choreography order, so re-targeting an element is not a cycle", () => {
    const r = resolveBeats(
      scene([
        beat("a", 0.3, 1.2),
        beat("b", { after: "a", offset: 0.1 }, 0.5),
        beat("a", { after: "b", offset: 0.1 }),
      ]),
    );
    expect(r.map((x) => x.start)).toEqual([0.3, 1.6, 2.2]);
  });

  it("supports forward references and rejects genuine cycles", () => {
    expect(resolveBeats(scene([beat("a", { after: "b", offset: 0 }), beat("b", 1)]))[0]?.start).toBe(2);
    expect(() =>
      resolveBeats(scene([beat("a", { after: "b", offset: 0 }), beat("b", { after: "a", offset: 0 })])),
    ).toThrow(/circular/);
  });

  it("clamps beats into the scene window", () => {
    const [r] = resolveBeats(scene([beat("a", 9, 3)]));
    expect(r?.start).toBeLessThan(5);
    expect(r && r.start + r.duration).toBeLessThanOrEqual(5);
  });

  it("maps easing tokens to GSAP eases", () => {
    expect(GSAP_EASE).toEqual({
      decelerate: "power3.out",
      standard: "power2.inOut",
      emphasized: "expo.out",
      accelerate: "power2.in",
      linear: "none",
      "spring-soft": "back.out(1.4)",
      snap: "power4.out",
    });
  });

  it("tokenizes code and formats metrics", () => {
    const tokens = tokenizeCode(`const x = f("a b", 42); // done`);
    expect(tokens.find((t) => t.text === "const")?.cls).toBe("tk-kw");
    expect(tokens.find((t) => t.text === `"a b"`)?.cls).toBe("tk-str");
    expect(tokens.find((t) => t.text === "42")?.cls).toBe("tk-num");
    expect(tokens.find((t) => t.text === "// done")?.cls).toBe("tk-com");
    expect(tokens.map((t) => t.text).join("")).toBe(`const x = f("a b", 42); // done`);
    expect(formatMetric(1234567.891, 2)).toBe("1,234,567.89");
    expect(formatMetric(-12, 0)).toBe("-12");
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});
