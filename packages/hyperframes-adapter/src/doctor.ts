import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { ffmpegVersions } from "@motion-mcp/media";
import { runHyperframes } from "./cli.ts";

const require = createRequire(import.meta.url);

export const MIN_NODE_MAJOR = 22;

export interface DoctorCheck {
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  node: DoctorCheck & { version: string };
  hyperframes: DoctorCheck & { version?: string };
  chrome: DoctorCheck & { path?: string; installed: boolean };
  ffmpeg: DoctorCheck & { ffmpeg?: string; ffprobe?: string };
}

export interface DoctorOptions {
  /** Run `hyperframes browser ensure` (may download Chrome) when no browser is found. Default true. */
  ensureBrowser?: boolean;
  timeoutMs?: number;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

async function browserPath(timeoutMs: number): Promise<string | undefined> {
  const res = await runHyperframes(["browser", "path"], { cwd: process.cwd(), timeoutMs });
  const path = lastLine(res.stdout);
  return res.exitCode === 0 && path && existsSync(path) ? path : undefined;
}

/** Check the local render toolchain: Node, the pinned HyperFrames CLI, Chrome and FFmpeg/FFprobe. */
export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const node = {
    ok: nodeMajor >= MIN_NODE_MAJOR,
    version: nodeVersion,
    detail: nodeMajor >= MIN_NODE_MAJOR ? `Node ${nodeVersion}` : `Node ${nodeVersion} < ${MIN_NODE_MAJOR}`,
  };

  let hyperframes: DoctorReport["hyperframes"];
  try {
    const pkg = require("hyperframes/package.json") as { version?: string };
    hyperframes = { ok: true, version: pkg.version, detail: `hyperframes ${pkg.version ?? "unknown"}` };
  } catch (err) {
    hyperframes = { ok: false, detail: `hyperframes CLI not installed: ${errText(err)}` };
  }

  let chrome: DoctorReport["chrome"] = { ok: false, installed: false, detail: "not checked" };
  if (hyperframes.ok) {
    try {
      let path = await browserPath(30_000);
      let detail = "found";
      if (!path && (opts.ensureBrowser ?? true)) {
        const ensured = await runHyperframes(["browser", "ensure"], { cwd: process.cwd(), timeoutMs });
        path = ensured.exitCode === 0 ? await browserPath(30_000) : undefined;
        detail = path
          ? "installed by `hyperframes browser ensure`"
          : `browser ensure failed: ${lastLine(ensured.stderr)}`;
      }
      chrome = path
        ? { ok: true, installed: true, path, detail }
        : { ok: false, installed: false, detail: detail === "found" ? "Chrome not found" : detail };
    } catch (err) {
      chrome = { ok: false, installed: false, detail: `browser check failed: ${errText(err)}` };
    }
  }

  let ffmpeg: DoctorReport["ffmpeg"];
  try {
    const v = await ffmpegVersions();
    ffmpeg = { ok: true, ffmpeg: v.ffmpeg, ffprobe: v.ffprobe, detail: v.ffmpeg };
  } catch (err) {
    ffmpeg = { ok: false, detail: `FFmpeg/FFprobe unavailable: ${errText(err)}` };
  }

  return { ok: node.ok && hyperframes.ok && chrome.ok && ffmpeg.ok, node, hyperframes, chrome, ffmpeg };
}
