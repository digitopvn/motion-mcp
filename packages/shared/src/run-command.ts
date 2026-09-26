import { spawn } from "node:child_process";
import { MotionError } from "./errors.ts";
import { redact } from "./redact.ts";

export interface RunCommandOptions {
  cwd: string;
  /** Environment for the child. Defaults to a scrubbed copy of process.env (see `scrubbedEnv`). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Max bytes of stdout/stderr kept in memory. */
  maxBuffer?: number;
  input?: string;
}

export interface RunCommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const BASE_ENV_ALLOW = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "TZ",
  "PUPPETEER_EXECUTABLE_PATH",
  "PUPPETEER_CACHE_DIR",
  "FFMPEG_PATH",
  "FFPROBE_PATH",
  "XDG_CACHE_HOME",
  "NODE_OPTIONS",
];

/**
 * A minimal child-process environment: OS essentials plus explicitly passed variables.
 * Secrets are never inherited implicitly; callers must pass the exact keys a tool needs.
 */
export function scrubbedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_ALLOW) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Spawn a command with an argv array (never a shell string). Output is redacted. */
export function runCommand(
  command: string,
  args: string[],
  opts: RunCommandOptions,
): Promise<RunCommandResult> {
  const started = Date.now();
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? scrubbedEnv(),
      windowsHide: true,
      shell: false,
      signal: opts.signal,
    });
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            killedByTimeout = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5000).unref();
          }, opts.timeoutMs)
        : undefined;
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < maxBuffer) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < maxBuffer) stderr += d.toString("utf8");
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(
        new MotionError("INTERNAL", `Failed to start ${command}: ${redact(err.message)}`, {
          cause: err,
          details: { command },
        }),
      );
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: RunCommandResult = {
        command,
        args,
        exitCode: code ?? -1,
        stdout: redact(stdout),
        stderr: redact(stderr),
        durationMs: Date.now() - started,
      };
      if (killedByTimeout) {
        reject(
          new MotionError("TIMEOUT", `${command} timed out after ${opts.timeoutMs}ms`, {
            retryable: true,
            details: { stderr: result.stderr.slice(-2000) },
          }),
        );
        return;
      }
      resolve(result);
    });
  });
}
