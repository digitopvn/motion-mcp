import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MotionError, type RunCommandResult, runCommand, scrubbedEnv } from "@motion-mcp/shared";

/**
 * Thin FFmpeg/FFprobe helpers used after rendering: finishing MP4s, probing, frame
 * extraction, contact-sheet tiling and black-frame detection. Every call spawns the
 * binary with an argv array (never a shell string) and a scrubbed environment.
 */

export interface FfmpegOptions {
  /** Defaults to `FFMPEG_PATH` or `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Defaults to `FFPROBE_PATH` or `ffprobe` on PATH. */
  ffprobePath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface MediaProbe {
  width: number;
  height: number;
  fps: number;
  /** Container duration in seconds. */
  duration: number;
  /** Video codec name (for example `h264`). */
  codec: string;
  pixFmt?: string;
  hasAudio: boolean;
  audioCodec?: string;
  audioSampleRate?: number;
  sizeBytes?: number;
}

export interface FinishMp4Options extends FfmpegOptions {
  /** H.264 constant rate factor. Default 20. */
  crf?: number;
  /** x264 preset. Default `medium`. */
  preset?: string;
  /** Downscale (never upscale) so the output height is at most this many pixels. */
  maxHeight?: number;
}

export interface TileImagesOptions extends FfmpegOptions {
  /** Number of columns. Defaults to ceil(sqrt(n)). */
  columns?: number;
  /** Width of each tile in px. Default 480. Height follows `tileHeight` or 16:9. */
  tileWidth?: number;
  tileHeight?: number;
  /** Gap between tiles in px, filled with `background`. Default 8. */
  gap?: number;
  /** Hex background color (`#rrggbb`). Default `#111111`. */
  background?: string;
}

export interface BlackSegment {
  start: number;
  end: number;
  duration: number;
}

export interface DetectBlackOptions extends FfmpegOptions {
  /** Minimum black duration in seconds to report. Default 0.1. */
  minDuration?: number;
  /** Pixel luminance threshold (0..1). Default 0.1. */
  pixelThreshold?: number;
  /** Ratio of black pixels for a frame to count as black (0..1). Default 0.98. */
  pictureThreshold?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function ffmpegBin(opts: FfmpegOptions): string {
  return opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
}

function ffprobeBin(opts: FfmpegOptions): string {
  return opts.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
}

async function run(
  bin: string,
  args: string[],
  opts: FfmpegOptions,
  what: string,
): Promise<RunCommandResult> {
  const result = await runCommand(bin, args, {
    cwd: process.cwd(),
    env: scrubbedEnv(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
  });
  if (result.exitCode !== 0) {
    throw new MotionError("RENDER", `${what} failed (exit ${result.exitCode})`, {
      details: { command: bin, stderr: result.stderr.slice(-2000) },
    });
  }
  return result;
}

/** Parse an FFmpeg rational (`30000/1001`, `30/1`, `25`) into a number; 0 when unknown. */
export function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return 0;
  if (den === undefined) return num;
  return den > 0 && Number.isFinite(den) ? num / den : 0;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; size?: string };
}

/** Normalize raw `ffprobe -print_format json` output. Exported for tests. */
export function parseProbeJson(raw: string): MediaProbe {
  let data: FfprobeOutput;
  try {
    data = JSON.parse(raw) as FfprobeOutput;
  } catch (err) {
    throw new MotionError("RENDER", "ffprobe returned invalid JSON", { cause: err });
  }
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) throw new MotionError("RENDER", "no video stream found");
  const fps = parseRational(video.avg_frame_rate) || parseRational(video.r_frame_rate);
  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  const size = Number(data.format?.size);
  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: Math.round(fps * 1000) / 1000,
    duration: Number.isFinite(duration) ? duration : 0,
    codec: video.codec_name ?? "unknown",
    pixFmt: video.pix_fmt,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    sizeBytes: Number.isFinite(size) ? size : undefined,
  };
}

export async function probe(file: string, opts: FfmpegOptions = {}): Promise<MediaProbe> {
  const result = await run(
    ffprobeBin(opts),
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", resolve(file)],
    opts,
    "ffprobe",
  );
  return parseProbeJson(result.stdout);
}

/**
 * Re-encode a rendered video into a web-ready MP4: H.264 (CRF 20 by default), yuv420p,
 * `+faststart`, and AAC 48 kHz when the input carries audio. Optionally downscales.
 */
export async function finishMp4(
  input: string,
  output: string,
  opts: FinishMp4Options = {},
): Promise<MediaProbe> {
  const source = await probe(input, opts);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", resolve(input), "-map", "0:v:0"];
  if (source.hasAudio) args.push("-map", "0:a:0");
  if (opts.maxHeight && source.height > opts.maxHeight) {
    // -2 keeps the width even (required by yuv420p) while preserving the aspect ratio.
    args.push("-vf", `scale=-2:${Math.floor(opts.maxHeight / 2) * 2}:flags=lanczos`);
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    opts.preset ?? "medium",
    "-crf",
    String(opts.crf ?? 20),
    "-pix_fmt",
    "yuv420p",
  );
  if (source.hasAudio) args.push("-c:a", "aac", "-ar", "48000", "-b:a", "192k");
  args.push("-movflags", "+faststart", resolve(output));
  await mkdir(dirname(resolve(output)), { recursive: true });
  await run(ffmpegBin(opts), args, opts, "ffmpeg finish");
  return probe(output, opts);
}

/** Extract one frame at `time` seconds as PNG/JPEG (by extension). */
export async function extractFrame(
  video: string,
  time: number,
  output: string,
  opts: FfmpegOptions = {},
): Promise<string> {
  if (!Number.isFinite(time) || time < 0) throw new MotionError("VALIDATION", `invalid frame time ${time}`);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await run(
    ffmpegBin(opts),
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      time.toFixed(3),
      "-i",
      resolve(video),
      "-frames:v",
      "1",
      resolve(output),
    ],
    opts,
    "ffmpeg extract frame",
  );
  return resolve(output);
}

function normalizeHexColor(color: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color))
    throw new MotionError("VALIDATION", `expected #rrggbb color, got ${color}`);
  return `0x${color.slice(1)}`;
}

/**
 * Tile images into one PNG grid (contact sheet). Each image is letterboxed into a
 * fixed tile so mixed sizes are fine; empty trailing cells are filled with the background.
 */
export async function tileImages(
  images: string[],
  output: string,
  opts: TileImagesOptions = {},
): Promise<string> {
  if (images.length === 0) throw new MotionError("VALIDATION", "tileImages needs at least one image");
  const n = images.length;
  const columns = Math.max(1, Math.min(n, opts.columns ?? Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / columns);
  const tileW = Math.floor((opts.tileWidth ?? 480) / 2) * 2;
  const tileH = Math.floor((opts.tileHeight ?? Math.round((tileW * 9) / 16)) / 2) * 2;
  const gap = Math.max(0, Math.floor(opts.gap ?? 8));
  const bg = normalizeHexColor(opts.background ?? "#111111");
  const sheetW = columns * tileW + (columns + 1) * gap;
  const sheetH = rows * tileH + (rows + 1) * gap;

  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const image of images) args.push("-i", resolve(image));
  args.push("-f", "lavfi", "-i", `color=c=${bg}:s=${sheetW}x${sheetH}:d=1`);

  const filters: string[] = [];
  for (let i = 0; i < n; i++) {
    filters.push(
      `[${i}:v]scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1[t${i}]`,
    );
  }
  let last = `${n}:v`;
  for (let i = 0; i < n; i++) {
    const x = gap + (i % columns) * (tileW + gap);
    const y = gap + Math.floor(i / columns) * (tileH + gap);
    const out = i === n - 1 ? "sheet" : `o${i}`;
    filters.push(`[${last}][t${i}]overlay=${x}:${y}[${out}]`);
    last = out;
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[sheet]", "-frames:v", "1", resolve(output));
  await mkdir(dirname(resolve(output)), { recursive: true });
  await run(ffmpegBin(opts), args, opts, "ffmpeg tile images");
  return resolve(output);
}

/** Parse `blackdetect` lines from FFmpeg stderr. Exported for tests. */
export function parseBlackDetect(stderr: string): BlackSegment[] {
  const segments: BlackSegment[] = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g;
  for (const m of stderr.matchAll(re)) {
    segments.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return segments;
}

/** Find black segments (empty frames) in a video. */
export async function detectBlack(video: string, opts: DetectBlackOptions = {}): Promise<BlackSegment[]> {
  const d = opts.minDuration ?? 0.1;
  const pix = opts.pixelThreshold ?? 0.1;
  const pic = opts.pictureThreshold ?? 0.98;
  const result = await run(
    ffmpegBin(opts),
    [
      "-hide_banner",
      "-nostats",
      "-i",
      resolve(video),
      "-vf",
      `blackdetect=d=${d}:pix_th=${pix}:pic_th=${pic}`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    opts,
    "ffmpeg blackdetect",
  );
  return parseBlackDetect(result.stderr);
}

/** Return the FFmpeg/FFprobe version lines, or throw when a binary is missing. */
export async function ffmpegVersions(opts: FfmpegOptions = {}): Promise<{ ffmpeg: string; ffprobe: string }> {
  const [a, b] = await Promise.all([
    run(ffmpegBin(opts), ["-hide_banner", "-version"], { ...opts, timeoutMs: 30_000 }, "ffmpeg -version"),
    run(ffprobeBin(opts), ["-hide_banner", "-version"], { ...opts, timeoutMs: 30_000 }, "ffprobe -version"),
  ]);
  return { ffmpeg: a.stdout.split(/\r?\n/)[0] ?? "", ffprobe: b.stdout.split(/\r?\n/)[0] ?? "" };
}
