import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProducerLogger, RenderConfigInput, RenderJob } from "@hyperframes/producer";
import { finishMp4, type MediaProbe } from "@motion-mcp/media";
import { createLogger, type Logger, MotionError, toMotionError } from "@motion-mcp/shared";
import { runHyperframes } from "./cli.ts";
import { readProjectIr } from "./qa.ts";

export type RenderPreset = "preview" | "final" | "final-4k";

export interface RenderProgress {
  /** 0..1 */
  progress: number;
  stage: string;
}

export interface RenderOptions {
  preset: RenderPreset;
  /** Final MP4 path. Parent directories are created. */
  outputPath: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
  /** Override the preset frame rate. */
  fps?: number;
  /** Parallel capture workers (default: producer auto). */
  workers?: number;
  logger?: Logger;
  /** Force the CLI subprocess path instead of the in-process producer. */
  forceCli?: boolean;
}

export interface RenderResult {
  outputPath: string;
  /** Wall-clock render time including the finishing encode, in milliseconds. */
  durationMs: number;
  probe: MediaProbe;
  preset: RenderPreset;
  renderer: "producer" | "cli";
  fps: number;
  warnings: string[];
}

interface PresetPlan {
  fps: number;
  quality: "draft" | "standard" | "high";
  /** Producer output resolution (device-scale-factor upscale), 4K only. */
  outputResolution?: "landscape-4k" | "portrait-4k" | "square-4k";
  finish: { crf: number; preset: string; maxHeight?: number };
}

/**
 * Preset → render settings.
 * - preview: draft capture at ≤15 fps, finished at ≤540p with a fast x264 preset. The producer can
 *   only upscale (integer device-scale-factor), so the downscale happens in the finishing encode.
 * - final: standard capture at the composition's native size and frame rate, CRF 18.
 * - final-4k: 2× device-scale-factor capture; only for 1920×1080-class compositions whose size is an
 *   exact half of a 4K canvas. Anything else is rejected up front with a clear error.
 */
export function planPreset(
  preset: RenderPreset,
  format: { width: number; height: number; fps: number },
  fpsOverride?: number,
): PresetPlan {
  if (fpsOverride !== undefined && (!Number.isFinite(fpsOverride) || fpsOverride < 1 || fpsOverride > 120)) {
    throw new MotionError("VALIDATION", `fps must be between 1 and 120, got ${fpsOverride}`);
  }
  switch (preset) {
    case "preview":
      return {
        fps: fpsOverride ?? Math.min(15, format.fps),
        quality: "draft",
        finish: { crf: 26, preset: "veryfast", maxHeight: 540 },
      };
    case "final":
      return { fps: fpsOverride ?? format.fps, quality: "standard", finish: { crf: 18, preset: "medium" } };
    case "final-4k": {
      const { width, height } = format;
      const target =
        width === 1920 && height === 1080
          ? "landscape-4k"
          : width === 1080 && height === 1920
            ? "portrait-4k"
            : width === 1080 && height === 1080
              ? "square-4k"
              : undefined;
      if (!target) {
        throw new MotionError(
          "VALIDATION",
          `final-4k is not supported for a ${width}x${height} composition; 4K output needs a 1920x1080, 1080x1920 or 1080x1080 composition`,
        );
      }
      return {
        fps: fpsOverride ?? format.fps,
        quality: "high",
        outputResolution: target,
        finish: { crf: 18, preset: "medium" },
      };
    }
  }
}

type ProducerModule = typeof import("@hyperframes/producer");

type ConsoleMethod = "log" | "info" | "debug";
let consoleRedirects = 0;
const originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};

/**
 * The producer's browser and capture layers print progress with `console.log`, i.e. to stdout.
 * Stdout is a protocol channel for stdio MCP servers and `--json` CLIs, so while a producer
 * render runs, stdout-bound console output is routed to the logger at debug level (stderr).
 * Reference-counted so overlapping renders restore the console only when the last one ends.
 */
async function withConsoleOnStderr<T>(log: Logger, fn: () => Promise<T>): Promise<T> {
  const methods: ConsoleMethod[] = ["log", "info", "debug"];
  if (consoleRedirects++ === 0) {
    for (const m of methods) {
      originalConsole[m] = console[m];
      console[m] = (...args: unknown[]) =>
        log.debug(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    }
  }
  try {
    return await fn();
  } finally {
    if (--consoleRedirects === 0) {
      for (const m of methods) {
        const orig = originalConsole[m];
        if (orig) console[m] = orig;
      }
    }
  }
}

async function loadProducer(log: Logger): Promise<ProducerModule | undefined> {
  try {
    return await import("@hyperframes/producer");
  } catch (err) {
    log.warn("hyperframes producer import failed; falling back to the CLI renderer", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Render a compiled HyperFrames project to a finished, web-ready MP4. */
export async function renderProject(projectDir: string, opts: RenderOptions): Promise<RenderResult> {
  const dir = resolve(projectDir);
  const outputPath = resolve(opts.outputPath);
  const log = opts.logger ?? createLogger({ component: "hyperframes-render" }, "warn");
  const ir = await readProjectIr(dir);
  const plan = planPreset(opts.preset, ir.format, opts.fps);
  const rawPath = `${outputPath}.raw.mp4`;
  const warnings: string[] = [];
  const started = performance.now();
  const report = (progress: number, stage: string) => {
    try {
      opts.onProgress?.({ progress: Math.min(1, Math.max(0, progress)), stage });
    } catch (err) {
      log.warn("render progress callback threw", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (opts.signal?.aborted) throw new MotionError("CANCELLED", "render cancelled before start");
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(rawPath, { force: true });

  let renderer: RenderResult["renderer"] = "cli";
  try {
    const producer = opts.forceCli ? undefined : await loadProducer(log);
    if (producer) {
      renderer = "producer";
      await renderWithProducer(producer, dir, rawPath, plan, opts, log, warnings, report);
    } else {
      await renderWithCli(dir, rawPath, plan, opts, report);
    }
    if (opts.signal?.aborted) throw new MotionError("CANCELLED", "render cancelled");
    report(0.95, "finishing");
    const probe = await finishMp4(rawPath, outputPath, { ...plan.finish, signal: opts.signal });
    report(1, "complete");
    return {
      outputPath,
      durationMs: Math.round(performance.now() - started),
      probe,
      preset: opts.preset,
      renderer,
      fps: plan.fps,
      warnings,
    };
  } catch (err) {
    if (opts.signal?.aborted) throw new MotionError("CANCELLED", "render cancelled", { cause: err });
    const e = toMotionError(err, "RENDER");
    throw e.code === "INTERNAL"
      ? new MotionError("RENDER", e.message, { cause: err, details: e.details })
      : e;
  } finally {
    await rm(rawPath, { force: true }).catch(() => undefined);
  }
}

async function renderWithProducer(
  producer: ProducerModule,
  dir: string,
  rawPath: string,
  plan: PresetPlan,
  opts: RenderOptions,
  log: Logger,
  warnings: string[],
  report: (progress: number, stage: string) => void,
): Promise<void> {
  const config: RenderConfigInput = {
    fps: plan.fps,
    quality: plan.quality,
    format: "mp4",
    entryFile: "index.html",
    strictness: "best-effort",
    logger: log satisfies ProducerLogger,
    ...(opts.workers ? { workers: opts.workers } : {}),
    ...(plan.outputResolution ? { outputResolution: plan.outputResolution } : {}),
  };
  const job: RenderJob = producer.createRenderJob(config);
  try {
    await withConsoleOnStderr(log, () =>
      producer.executeRenderJob(
        job,
        dir,
        rawPath,
        (j) => report((j.progress / 100) * 0.95, j.currentStage),
        opts.signal,
      ),
    );
  } catch (err) {
    if (err instanceof producer.RenderCancelledError || opts.signal?.aborted) {
      throw new MotionError("CANCELLED", "render cancelled", { cause: err });
    }
    throw new MotionError("RENDER", `HyperFrames render failed: ${job.error ?? (err as Error).message}`, {
      cause: err,
      details: { stage: job.failedStage ?? job.currentStage },
    });
  }
  if (job.status === "failed") {
    throw new MotionError("RENDER", `HyperFrames render failed: ${job.error ?? "unknown error"}`, {
      details: { stage: job.failedStage ?? job.currentStage },
    });
  }
  for (const w of job.warnings) warnings.push(w.message ?? String(w.code ?? "render warning"));
}

async function renderWithCli(
  dir: string,
  rawPath: string,
  plan: PresetPlan,
  opts: RenderOptions,
  report: (progress: number, stage: string) => void,
): Promise<void> {
  const args = ["render", dir, "-o", rawPath, "-f", String(plan.fps), "-q", plan.quality, "--quiet"];
  if (plan.outputResolution) args.push("--resolution", plan.outputResolution);
  if (opts.workers) args.push("-w", String(opts.workers));
  report(0.05, "rendering (cli)");
  const result = await runHyperframes(args, { cwd: dir, timeoutMs: 60 * 60_000, signal: opts.signal });
  if (result.exitCode !== 0) {
    throw new MotionError("RENDER", `hyperframes render exited with ${result.exitCode}`, {
      details: { stderr: result.stderr.slice(-2000) },
    });
  }
}
