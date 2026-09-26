import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { MotionError, type RunCommandResult, runCommand, scrubbedEnv } from "@motion-mcp/shared";

const require = createRequire(import.meta.url);

/** Environment that keeps the HyperFrames CLI offline-quiet and side-effect free. */
export const HYPERFRAMES_ENV = {
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_SKIP_SKILLS: "1",
} as const;

let cachedBin: string | undefined;

/** Absolute path of the pinned `hyperframes` CLI entry (resolved from this package's dependencies). */
export function hyperframesBin(): string {
  if (cachedBin) return cachedBin;
  try {
    cachedBin = join(dirname(require.resolve("hyperframes/package.json")), "bin", "hyperframes.mjs");
  } catch (err) {
    throw new MotionError("CONFIG", "The hyperframes CLI package is not installed", { cause: err });
  }
  return cachedBin;
}

export interface HyperframesCliOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Run `hyperframes <args>` with the current Node binary and a scrubbed environment. */
export function runHyperframes(args: string[], opts: HyperframesCliOptions): Promise<RunCommandResult> {
  return runCommand(process.execPath, [hyperframesBin(), ...args], {
    cwd: opts.cwd,
    env: scrubbedEnv(HYPERFRAMES_ENV),
    timeoutMs: opts.timeoutMs ?? 300_000,
    signal: opts.signal,
  });
}

/**
 * Parse the JSON document a `--json` command prints on stdout. Some commands exit non-zero
 * while still reporting (e.g. `check` when not ok), so the exit code alone is not a failure.
 */
export function parseCliJson(result: RunCommandResult, what: string): unknown {
  const text = result.stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // fall through to the error below
    }
  }
  throw new MotionError("RENDER", `hyperframes ${what} did not produce JSON (exit ${result.exitCode})`, {
    details: { stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-1000) },
  });
}
