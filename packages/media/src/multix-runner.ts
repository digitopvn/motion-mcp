import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionError, redact, registerSecret, runCommand, scrubbedEnv } from "@motion-mcp/shared";

/** Pinned multix CLI version; bump deliberately together with the argv tables in `capabilities.ts`. */
export const MULTIX_VERSION = "0.7.0";

export interface MultixRunRequest {
  /** Arguments after the `multix` binary, e.g. `["gemini", "generate", "--prompt", "..."]`. */
  argv: string[];
  /** Provider secrets/config for this call only (already filtered to what the provider needs). */
  providerEnv: Record<string, string>;
  /** Absolute directory that receives every generated file. */
  outputDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MultixRunResult {
  argv: string[];
  exitCode: number;
  /** Existing generated files inside `outputDir` (absolute paths). */
  files: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Anything that can execute a multix command; the registry depends on this so tests can inject a fake. */
export interface MediaCommandRunner {
  run(request: MultixRunRequest): Promise<MultixRunResult>;
}

/** How to launch the CLI: `command args... <argv>`. */
export interface MultixLaunch {
  command: string;
  prefixArgs: string[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Locate the pinned multix CLI. `MULTIX_BIN` may point at a `cli.js` (run with the current Node) or a
 * command on PATH. Otherwise walk up from this module to the installed package and run its `dist/cli.js`
 * with `process.execPath`, which avoids Windows `.cmd` shims and shell parsing.
 */
export function resolveMultixLaunch(
  multixBin?: string,
  fromDir = dirname(fileURLToPath(import.meta.url)),
): MultixLaunch {
  if (multixBin) {
    return /\.(c|m)?js$/i.test(multixBin)
      ? { command: process.execPath, prefixArgs: [resolve(multixBin)] }
      : { command: multixBin, prefixArgs: [] };
  }
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", "@mrgoonie", "multix", "dist", "cli.js");
    if (existsSync(candidate)) return { command: process.execPath, prefixArgs: [candidate] };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new MotionError(
    "CONFIG",
    `multix CLI (@mrgoonie/multix@${MULTIX_VERSION}) is not installed; set MULTIX_BIN`,
  );
}

/**
 * Child environment for one multix call: OS essentials, the provider keys for this call only, and
 * switches that stop multix from reading `~/.multix/.env` or writing outside the controlled output dir.
 */
export function buildMultixEnv(providerEnv: Record<string, string>, outputDir: string): NodeJS.ProcessEnv {
  return scrubbedEnv({
    ...providerEnv,
    MULTIX_DISABLE_HOME_ENV: "1",
    MULTIX_OUTPUT_DIR: outputDir,
    NO_COLOR: "1",
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are control characters by definition.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const GENERIC_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?]+\.[A-Za-z0-9]{2,5}/g;

function trimPathToken(token: string): string {
  return token
    .trim()
    .replace(/^["'`(]+/, "")
    .replace(/["'`),.;:]+$/, "");
}

/**
 * Extract candidate output paths from multix stdout. multix prints human text (for example
 * `Generated 1 image(s):` followed by indented absolute paths), so this looks for the controlled output
 * directory first (robust to spaces in paths) and falls back to generic absolute paths with an extension.
 */
export function parseOutputPaths(stdout: string, outputDir: string): string[] {
  const found = new Set<string>();
  const roots = [...new Set([outputDir, outputDir.replaceAll("\\", "/"), outputDir.replaceAll("/", "\\")])];
  for (const rawLine of stdout.replace(ANSI, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let matchedRoot = false;
    for (const root of roots) {
      const at = line.toLowerCase().indexOf(root.toLowerCase());
      if (at < 0) continue;
      const candidate = trimPathToken(line.slice(at));
      if (extname(candidate)) {
        found.add(resolve(candidate));
        matchedRoot = true;
      }
      break;
    }
    if (matchedRoot) continue;
    for (const match of line.matchAll(GENERIC_PATH)) found.add(resolve(trimPathToken(match[0])));
  }
  return [...found];
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Keep only regular files that really exist inside `outputDir` (never trust stdout blindly). */
export function existingOutputs(candidates: string[], outputDir: string): string[] {
  return candidates.filter((p) => {
    if (!isInside(outputDir, p)) return false;
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Extract the value of `--output <path>` from an argv array, if present. */
export function explicitOutput(argv: string[]): string | undefined {
  const i = argv.indexOf("--output");
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Runs the pinned multix CLI with an argv array (never a shell string), a throwaway cwd (so a planted
 * `.env` cannot inject keys or base URLs), and a scrubbed environment.
 */
export class MultixRunner implements MediaCommandRunner {
  private readonly launch: MultixLaunch;

  constructor(options: { multixBin?: string; launch?: MultixLaunch } = {}) {
    this.launch = options.launch ?? resolveMultixLaunch(options.multixBin);
  }

  async run(request: MultixRunRequest): Promise<MultixRunResult> {
    const [group, action] = request.argv;
    if (!group || !action)
      throw new MotionError("VALIDATION", "multix argv must include a provider and a command");
    if (group === "check" || group === "update") {
      // `check` prints partially redacted keys and `update` mutates the install; neither belongs in a job.
      throw new MotionError("FORBIDDEN", `multix ${group} is not allowed from the media runner`);
    }
    if (!isAbsolute(request.outputDir))
      throw new MotionError("VALIDATION", "multix outputDir must be absolute");
    for (const value of Object.values(request.providerEnv)) registerSecret(value);

    await mkdir(request.outputDir, { recursive: true });
    const cwd = await mkdtemp(join(tmpdir(), "motion-multix-"));
    try {
      const result = await runCommand(this.launch.command, [...this.launch.prefixArgs, ...request.argv], {
        cwd,
        env: buildMultixEnv(request.providerEnv, request.outputDir),
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: request.signal,
      });
      if (result.exitCode !== 0) {
        const tail = redact((result.stderr || result.stdout).trim()).slice(-800);
        throw new MotionError(
          "PROVIDER",
          `multix ${group} ${action} failed (exit ${result.exitCode}): ${tail}`,
          {
            retryable: true,
            details: { provider: group, command: action, exitCode: result.exitCode },
          },
        );
      }
      const output = explicitOutput(request.argv);
      const candidates = [
        ...(output ? [resolve(output)] : []),
        ...parseOutputPaths(result.stdout, request.outputDir),
      ];
      const files = existingOutputs([...new Set(candidates)], request.outputDir);
      if (files.length === 0) {
        throw new MotionError("PROVIDER", `multix ${group} ${action} reported success but produced no file`, {
          retryable: true,
          details: { provider: group, command: action, stdout: result.stdout.slice(-800) },
        });
      }
      return {
        argv: request.argv,
        exitCode: result.exitCode,
        files,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    } catch (err) {
      if (request.signal?.aborted) throw new MotionError("CANCELLED", "multix run cancelled", { cause: err });
      throw err;
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
