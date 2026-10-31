import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { redact } from "@motion-mcp/shared";

export type SandboxMode = "bwrap" | "none";

export interface SandboxPolicy {
  mode: SandboxMode;
  /** Absolute project directory: read-only inside the sandbox. */
  projectDir: string;
  /** Absolute directories inside the project that stay writable (the scene's `compositions/`). */
  writableDirs: readonly string[];
  /** Per-job private home (also holds `CLAUDE_CONFIG_DIR`); writable and deleted after the job. */
  homeDir: string;
  /** CPU-seconds cap for the agent process tree (via `prlimit`, when available). */
  cpuSeconds?: number;
  /** Largest file the agent may write, in bytes (via `prlimit`, when available). */
  maxFileBytes?: number;
  /** Receives redacted stderr lines from the agent process. */
  onStderr?: (line: string) => void;
}

export interface SandboxProbe {
  ok: boolean;
  mode: SandboxMode;
  reason?: string;
}

const MANAGED_SETTINGS_DIR = "/etc/claude-code";
const SYSTEM_RO_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc"];
const probeCache = new Map<SandboxMode, SandboxProbe>();

/**
 * Check once per process that the requested sandbox works on this host. `bwrap` needs unprivileged user
 * namespaces, which some container runtimes (Docker's default seccomp profile, for example) block.
 */
export function probeSandbox(mode: SandboxMode): SandboxProbe {
  const cached = probeCache.get(mode);
  if (cached) return cached;
  let result: SandboxProbe;
  if (mode === "none") {
    result = { ok: true, mode };
  } else {
    const run = spawnSync(
      "bwrap",
      ["--die-with-parent", "--unshare-all", "--share-net", "--ro-bind", "/", "/", "--", "true"],
      { timeout: 10_000, stdio: ["ignore", "ignore", "pipe"] },
    );
    result =
      run.status === 0
        ? { ok: true, mode }
        : {
            ok: false,
            mode,
            reason: run.error
              ? `bwrap is not installed or not runnable (${run.error.message})`
              : `bwrap cannot create a sandbox here: ${
                  String(run.stderr ?? "")
                    .trim()
                    .slice(0, 200) || `exit ${run.status}`
                }`,
          };
  }
  probeCache.set(mode, result);
  return result;
}

/** For tests: forget cached probe results. */
export function resetSandboxProbe(): void {
  probeCache.clear();
}

let prlimitPath: string | null | undefined;
function findPrlimit(): string | null {
  if (prlimitPath !== undefined) return prlimitPath;
  prlimitPath = ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p)) ?? null;
  return prlimitPath;
}

/**
 * The argv that runs `command args` inside the sandbox. Exposed for tests; `createSandboxSpawn` uses it.
 *
 * bwrap layout: system directories and the agent binary read-only, a fresh `/tmp`, the project read-only
 * with only `writableDirs` writable, and a private home. All namespaces are unshared except the network
 * (the agent must reach the Anthropic API). `--die-with-parent` ties the tree to the spawning process.
 */
export function sandboxArgv(policy: SandboxPolicy, command: string, args: readonly string[]): string[] {
  const limits: string[] = [];
  const prlimit = findPrlimit();
  if (prlimit) {
    limits.push(prlimit, "--core=0");
    if (policy.cpuSeconds) limits.push(`--cpu=${Math.ceil(policy.cpuSeconds)}`);
    if (policy.maxFileBytes) limits.push(`--fsize=${Math.ceil(policy.maxFileBytes)}`);
    limits.push("--");
  }
  if (policy.mode === "none") return [...limits, command, ...args];

  const bw = ["bwrap", "--die-with-parent", "--new-session", "--unshare-all", "--share-net"];
  for (const dir of SYSTEM_RO_DIRS) bw.push("--ro-bind-try", dir, dir);
  // Hide host-managed Claude Code settings so the agent only sees the options passed in code. The
  // directory must already exist: bwrap cannot create a mount point inside the read-only /etc bind.
  if (existsSync(MANAGED_SETTINGS_DIR)) bw.push("--tmpfs", MANAGED_SETTINGS_DIR);
  bw.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  // The SDK's native binary lives in node_modules; bind its directory so it can start.
  if (command.startsWith("/")) bw.push("--ro-bind", dirname(command), dirname(command));
  for (const extra of caFiles()) bw.push("--ro-bind-try", extra, extra);
  bw.push("--ro-bind", policy.projectDir, policy.projectDir);
  for (const dir of policy.writableDirs) bw.push("--bind", dir, dir);
  bw.push("--bind", policy.homeDir, policy.homeDir, "--chdir", policy.projectDir, "--");
  return [...limits, ...bw, command, ...args];
}

function caFiles(): string[] {
  const files = [process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE].filter(
    (f): f is string => typeof f === "string" && f.startsWith("/") && existsSync(f),
  );
  return files;
}

/** Kill the whole process group (the sandbox and everything the agent started). */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

export interface SandboxSpawn {
  spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Force-kill every process this spawner started that is still running. */
  killAll(): void;
}

/**
 * `spawnClaudeCodeProcess` implementation: runs the agent in its own process group (so abort kills the
 * whole tree, not just the direct child) inside the configured sandbox and resource limits.
 */
export function createSandboxSpawn(policy: SandboxPolicy): SandboxSpawn {
  const children = new Set<ChildProcess>();
  return {
    spawn(options) {
      const [file, ...argv] = sandboxArgv(policy, options.command, options.args);
      const child = spawn(file as string, argv, {
        cwd: policy.mode === "none" ? (options.cwd ?? policy.projectDir) : undefined,
        env: options.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.once("exit", () => children.delete(child));
      child.stderr?.setEncoding("utf8");
      // Buffer by line so a secret split across chunks is still redacted whole.
      let pending = "";
      const emit = (line: string) => {
        if (line.trim()) policy.onStderr?.(redact(line).slice(0, 500));
      };
      child.stderr?.on("data", (chunk: string) => {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop() ?? "";
        if (pending.length > 8192) {
          emit(pending);
          pending = "";
        }
        for (const line of lines) emit(line);
      });
      child.stderr?.on("end", () => emit(pending));
      options.signal?.addEventListener("abort", () => killGroup(child, "SIGKILL"), { once: true });
      // The SDK calls kill() on close/abort; widen it to the process group.
      child.kill = (signal?: NodeJS.Signals | number) => {
        killGroup(child, typeof signal === "string" ? signal : "SIGTERM");
        return true;
      };
      return child as unknown as SpawnedProcess;
    },
    killAll() {
      for (const child of children) killGroup(child, "SIGKILL");
      children.clear();
    },
  };
}

/** Environment for the agent process: nothing inherited except locale and proxy plumbing. */
export function agentEnv(input: { apiKey: string; homeDir: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: input.homeDir,
    TMPDIR: "/tmp",
    CLAUDE_CONFIG_DIR: join(input.homeDir, ".claude"),
    ANTHROPIC_API_KEY: input.apiKey,
    CLAUDE_AGENT_SDK_CLIENT_APP: "motion-mcp/0.1.0",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const name of [
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}
