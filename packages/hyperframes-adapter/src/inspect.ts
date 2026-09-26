import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tileImages } from "@motion-mcp/media";
import type { MotionScene } from "@motion-mcp/motion-ir";
import { MotionError } from "@motion-mcp/shared";
import { parseCliJson, runHyperframes } from "./cli.ts";
import { effectiveTransitions } from "./motion.ts";
import { type CheckReport, normalizeCheckReport, readProjectIr, readSceneSpans } from "./qa.ts";
import { resolveBeats } from "./timing.ts";
import { num } from "./util.ts";

export interface InspectOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Run `hyperframes check --json` (runtime, layout, motion, contrast) and normalize the findings. */
export async function checkProject(projectDir: string, opts: InspectOptions = {}): Promise<CheckReport> {
  const dir = resolve(projectDir);
  const spans = await readSceneSpans(dir);
  const result = await runHyperframes(["check", dir, "--json"], { cwd: dir, ...opts });
  return normalizeCheckReport(parseCliJson(result, "check"), spans);
}

export interface SnapshotFrame {
  time: number;
  path: string;
}

export interface SnapshotOptions extends InspectOptions {
  /** Root-timeline seconds to capture. */
  at: readonly number[];
  /** Output directory (default `<project>/snapshots`). Existing PNGs in it are replaced. */
  outDir?: string;
}

const SAVED_FRAME_RE = /^frame-(\d+)-at-.*\.png$/;

/** Capture PNG frames at exact times via `hyperframes snapshot` (vision description disabled). */
export async function snapshotProject(projectDir: string, opts: SnapshotOptions): Promise<SnapshotFrame[]> {
  const dir = resolve(projectDir);
  if (opts.at.length === 0) throw new MotionError("VALIDATION", "snapshot needs at least one timestamp");
  for (const t of opts.at) {
    if (!Number.isFinite(t) || t < 0) throw new MotionError("VALIDATION", `invalid snapshot time ${t}`);
  }
  const outDir = opts.outDir
    ? isAbsolute(opts.outDir)
      ? opts.outDir
      : resolve(dir, opts.outDir)
    : join(dir, "snapshots");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const at = opts.at.map((t) => num(t)).join(",");
  const result = await runHyperframes(
    ["snapshot", dir, "--at", at, "--no-end", "--describe", "false", "-o", outDir],
    { cwd: dir, timeoutMs: opts.timeoutMs, signal: opts.signal },
  );
  // Frames are saved as `frame-NN-at-<t>s.png` in capture order; read them back from disk rather
  // than parsing console output, which is decorated for humans.
  const byIndex = new Map<number, string>();
  for (const name of await readdir(outDir)) {
    const m = name.match(SAVED_FRAME_RE);
    if (m?.[1]) byIndex.set(Number(m[1]), join(outDir, name));
  }
  if (result.exitCode !== 0 || byIndex.size !== opts.at.length) {
    throw new MotionError(
      "RENDER",
      `hyperframes snapshot saved ${byIndex.size}/${opts.at.length} frames (exit ${result.exitCode})`,
      { details: { stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-2000) } },
    );
  }
  return opts.at.map((time, i) => {
    const path = byIndex.get(i);
    if (!path) throw new MotionError("RENDER", `hyperframes snapshot did not save frame ${i}`);
    return { time, path };
  });
}

/**
 * The still "hold" window of a scene in scene-local seconds: after the in-transition and every
 * entrance beat has settled, before the out-transition or the first exit beat begins.
 */
export function holdWindow(scenes: MotionScene[], index: number): { start: number; end: number } {
  const scene = scenes[index];
  if (!scene) throw new MotionError("VALIDATION", `no scene at index ${index}`);
  const tr = effectiveTransitions(scenes, index);
  const inDur = tr.in.kind === "cut" ? 0 : tr.in.duration;
  const outDur = tr.out.kind === "cut" ? 0 : tr.out.duration;
  let start = inDur;
  let end = scene.duration - outDur;
  for (const rb of resolveBeats(scene)) {
    const p = rb.beat.primitive;
    if (p === "exit") end = Math.min(end, rb.start);
    else if (p !== "hold" && p !== "emphasize") start = Math.max(start, rb.start + rb.duration);
  }
  if (end - start < 0.1) {
    // No real hold (dense choreography): fall back to the middle of the untransitioned span.
    const mid = (inDur + scene.duration - outDur) / 2;
    return { start: mid, end: mid };
  }
  return { start, end };
}

export interface ContactSheetOptions extends InspectOptions {
  /** Frames per scene, evenly spread across each scene's hold (default 1). */
  framesPerScene?: number;
  /** Output image path (default `<project>/snapshots/contact-sheet.png`). */
  outPath?: string;
  /** Tile width in px (default 480). */
  tileWidth?: number;
}

export interface ContactSheet {
  path: string;
  frames: (SnapshotFrame & { sceneId: string })[];
  columns: number;
}

/** Capture N frames per scene at mid-hold points and tile them into one image (one row per scene). */
export async function contactSheet(
  projectDir: string,
  opts: ContactSheetOptions = {},
): Promise<ContactSheet> {
  const dir = resolve(projectDir);
  const perScene = opts.framesPerScene ?? 1;
  if (!Number.isInteger(perScene) || perScene < 1 || perScene > 12) {
    throw new MotionError("VALIDATION", "framesPerScene must be an integer between 1 and 12");
  }
  const ir = await readProjectIr(dir);
  const plan: { sceneId: string; time: number }[] = [];
  let offset = 0;
  const total = ir.scenes.reduce((s, sc) => s + sc.duration, 0);
  for (const [i, scene] of ir.scenes.entries()) {
    const hold = holdWindow(ir.scenes, i);
    for (let k = 0; k < perScene; k++) {
      const local = hold.start + ((k + 0.5) / perScene) * (hold.end - hold.start);
      plan.push({ sceneId: scene.id, time: Math.min(total - 0.001, Number(num(offset + local))) });
    }
    offset += scene.duration;
  }
  const framesDir = join(dir, "snapshots", "contact");
  const frames = await snapshotProject(dir, { ...opts, at: plan.map((p) => p.time), outDir: framesDir });
  const columns = perScene > 1 ? perScene : Math.min(4, plan.length);
  const outPath = opts.outPath ? resolve(dir, opts.outPath) : join(dir, "snapshots", "contact-sheet.png");
  const tileWidth = opts.tileWidth ?? 480;
  const tileHeight = Math.round((tileWidth * ir.format.height) / ir.format.width);
  await tileImages(
    frames.map((f) => f.path),
    outPath,
    { columns, tileWidth, tileHeight, gap: 8, background: "#111111" },
  );
  return {
    path: outPath,
    columns,
    frames: frames.map((f, i) => ({ ...f, sceneId: plan[i]?.sceneId ?? "" })),
  };
}

/** Keyframe inventory from `hyperframes keyframes --json` (GSAP tweens per element). */
export async function keyframesProject(
  projectDir: string,
  opts: InspectOptions & { selector?: string } = {},
): Promise<Record<string, unknown>> {
  const dir = resolve(projectDir);
  const args = ["keyframes", dir, "--json", "--runtime", "gsap"];
  if (opts.selector) args.push("--selector", opts.selector);
  const result = await runHyperframes(args, { cwd: dir, timeoutMs: opts.timeoutMs, signal: opts.signal });
  const json = parseCliJson(result, "keyframes");
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new MotionError("RENDER", "hyperframes keyframes returned an unexpected JSON shape");
  }
  return json as Record<string, unknown>;
}
