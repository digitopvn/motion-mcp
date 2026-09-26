import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CreativeSpec, compileCreativeSpec, type MotionIR } from "@motion-mcp/motion-ir";
import { doctor } from "../src/doctor.ts";

export const GOLDEN_FIXTURES = [
  "product-launch",
  "technical-explainer",
  "kinetic-typography",
  "data-visualization",
  "architecture-diagram",
] as const;

export function goldenSpec(name: string): CreativeSpec {
  const raw = readFileSync(
    resolve(import.meta.dirname, "../../../fixtures/golden", name, "creative-spec.json"),
    "utf8",
  );
  return CreativeSpec.parse(JSON.parse(raw));
}

export function goldenIr(name: string): MotionIR {
  return compileCreativeSpec(goldenSpec(name), { id: `proj_${name.replace(/-/g, "_")}` });
}

/** A 2-scene, 3-second IR derived from the product-launch golden (1.5 s per scene). */
export function shortIr(): MotionIR {
  const spec = goldenSpec("product-launch");
  const scenes = spec.scenes.slice(0, 2).map((s) => ({
    ...s,
    duration: 1.5,
    choreography: s.choreography?.map((b) => ({
      ...b,
      at: typeof b.at === "number" ? Math.min(b.at, 0.2) : b.at,
    })),
  }));
  return compileCreativeSpec(CreativeSpec.parse({ ...spec, scenes }), { id: "proj_short" });
}

export async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `motion-hf-${prefix}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

let toolchain: Promise<{ chrome: boolean; ffmpeg: boolean; reason: string }> | undefined;

/** Whether Chrome (headless shell) and FFmpeg are available locally; never downloads a browser. */
export function toolchainStatus(): Promise<{ chrome: boolean; ffmpeg: boolean; reason: string }> {
  toolchain ??= doctor({ ensureBrowser: false }).then((r) => ({
    chrome: r.chrome.ok,
    ffmpeg: r.ffmpeg.ok,
    reason: [r.chrome.ok ? "" : `chrome: ${r.chrome.detail}`, r.ffmpeg.ok ? "" : `ffmpeg: ${r.ffmpeg.detail}`]
      .filter(Boolean)
      .join("; "),
  }));
  return toolchain;
}
