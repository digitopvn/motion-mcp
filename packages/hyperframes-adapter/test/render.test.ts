import { existsSync } from "node:fs";
import { join } from "node:path";
import { probe } from "@motion-mcp/media";
import { afterAll, describe, expect, it } from "vitest";
import { createHyperframesAdapter } from "../src/adapter.ts";
import { holdWindow } from "../src/inspect.ts";
import { planPreset, type RenderProgress } from "../src/render.ts";
import { goldenIr, shortIr, tempDir, toolchainStatus } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

describe("render presets", () => {
  const hd = { width: 1920, height: 1080, fps: 30 };

  it("preview is a draft capture downscaled at finish", () => {
    expect(planPreset("preview", hd)).toMatchObject({
      fps: 15,
      quality: "draft",
      finish: { maxHeight: 540 },
    });
    expect(planPreset("preview", hd, 24).fps).toBe(24);
  });

  it("final keeps native frame rate and size", () => {
    const p = planPreset("final", hd);
    expect(p).toMatchObject({ fps: 30, quality: "standard" });
    expect(p.outputResolution).toBeUndefined();
    expect(p.finish.maxHeight).toBeUndefined();
  });

  it("final-4k upscales 1080-class compositions and rejects other sizes clearly", () => {
    expect(planPreset("final-4k", hd).outputResolution).toBe("landscape-4k");
    expect(planPreset("final-4k", { width: 1080, height: 1920, fps: 30 }).outputResolution).toBe(
      "portrait-4k",
    );
    expect(() => planPreset("final-4k", { width: 1280, height: 720, fps: 30 })).toThrow(/not supported/);
    expect(() => planPreset("final", hd, 0)).toThrow(/fps/);
  });
});

describe("hold windows", () => {
  it("places every hold after entrances and before the out-transition", () => {
    const ir = goldenIr("product-launch");
    for (const [i, scene] of ir.scenes.entries()) {
      const hold = holdWindow(ir.scenes, i);
      expect(hold.start).toBeGreaterThanOrEqual(0);
      expect(hold.end).toBeLessThanOrEqual(scene.duration);
      expect(hold.end).toBeGreaterThanOrEqual(hold.start);
    }
  });
});

const tc = await toolchainStatus();
const canRender = tc.chrome && tc.ffmpeg;

describe.skipIf(!canRender)(`preview render smoke test${canRender ? "" : ` [skipped: ${tc.reason}]`}`, () => {
  const adapter = createHyperframesAdapter();

  it("renders a 2-scene, 3-second preview MP4 and a contact sheet", async () => {
    const t = await tempDir("render");
    cleanups.push(t.cleanup);
    const ir = shortIr();
    expect(ir.scenes.length).toBe(2);
    const project = await adapter.compile(ir, join(t.dir, "project"));
    expect(project.duration).toBeCloseTo(3, 6);

    const progress: RenderProgress[] = [];
    const out = join(t.dir, "preview.mp4");
    const result = await adapter.render(project.projectDir, {
      preset: "preview",
      outputPath: out,
      onProgress: (p) => progress.push(p),
    });
    expect(result.outputPath).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.raw.mp4`)).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
    const info = await probe(out);
    expect(info.duration).toBeGreaterThan(2.8);
    expect(info.duration).toBeLessThan(3.2);
    expect(info).toMatchObject({
      width: 960,
      height: 540,
      codec: "h264",
      pixFmt: "yuv420p",
      hasAudio: false,
    });
    expect(result.probe.width).toBe(960);
    expect(progress.at(-1)).toEqual({ progress: 1, stage: "complete" });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]?.progress).toBeGreaterThanOrEqual(progress[i - 1]?.progress ?? 0);
    }

    const sheet = await adapter.contactSheet(project.projectDir, { framesPerScene: 2, tileWidth: 320 });
    expect(sheet.frames.map((f) => f.sceneId)).toEqual([
      ir.scenes[0]?.id,
      ir.scenes[0]?.id,
      ir.scenes[1]?.id,
      ir.scenes[1]?.id,
    ]);
    const sheetInfo = await probe(sheet.path);
    expect(sheetInfo.width).toBe(2 * 320 + 3 * 8);
  });

  it("honours an already-aborted signal", async () => {
    const t = await tempDir("abort");
    cleanups.push(t.cleanup);
    const project = await adapter.compile(shortIr(), join(t.dir, "project"));
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.render(project.projectDir, {
        preset: "preview",
        outputPath: join(t.dir, "x.mp4"),
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
