import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tool-call path guard for Pi workers. Pi's `cwd` is NOT a sandbox: built-in tools accept absolute paths,
 * `~`, `@`-prefixed and Git-Bash style drive paths. This guard mirrors Pi's own path normalization so the
 * path we check is the path the tool would touch, then follows symlinks of the nearest existing ancestor.
 * `bash` cannot be guarded this way; it stays disabled unless a caller opts in explicitly.
 */

export const PROTECTED_FILES: readonly string[] = ["motion-ir.json", "hyperframes.json"];

export interface PathGuardPolicy {
  projectDir: string;
  /** Project-relative files the worker may create or modify (e.g. `compositions/<sceneId>.html`). */
  writable: readonly string[];
  /** Allow read-only tools to open protected files (the IR is normally passed in the prompt instead). */
  allowProtectedReads?: boolean;
  /** Tool names allowed without path checks (custom tools such as `submit_scene`). */
  passthroughTools?: readonly string[];
  /** Allow `bash`; it bypasses path checks, so only enable it inside an OS-level sandbox. */
  allowBash?: boolean;
}

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

const UNICODE_SPACES = /[  -   　]/g;
const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Same normalization Pi applies before resolving a tool path against `cwd`. */
export function normalizeToolPath(input: string, home = homedir()): string {
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (process.platform === "win32" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\")) {
    const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) p = `${m[1]?.toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (p === "~") return home;
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\")))
    return join(home, p.slice(2));
  if (/^file:\/\//.test(p)) return fileURLToPath(p);
  return p;
}

export function resolveToolPath(input: string, cwd: string): string {
  const p = normalizeToolPath(input);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Resolve symlinks of the deepest existing ancestor so links inside the project cannot point outside. */
function canonical(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

export function isInsideDir(root: string, target: string): boolean {
  const rel = relative(fold(root), fold(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Glob patterns handed to grep/find must stay relative and must not climb out of the search root. */
function unsafePattern(pattern: string): boolean {
  const p = normalizeToolPath(pattern);
  return isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..");
}

function pathArgs(toolName: string, input: Record<string, unknown>): Array<string | undefined> {
  const path = typeof input.path === "string" ? input.path : undefined;
  // ls/grep/find default to cwd when no path is given.
  if (toolName === "ls" || toolName === "grep" || toolName === "find") return [path ?? "."];
  return [path];
}

export function createPathGuard(policy: PathGuardPolicy) {
  const root = canonical(resolve(policy.projectDir));
  const writable = new Set(policy.writable.map((w) => fold(canonical(resolve(root, w)))));
  const passthrough = new Set(policy.passthroughTools ?? []);

  const check = (toolName: string, input: Record<string, unknown>): GuardDecision => {
    if (passthrough.has(toolName)) return { block: false };
    if (toolName === "bash" || toolName === "powershell") {
      return policy.allowBash && toolName === "bash"
        ? { block: false }
        : { block: true, reason: `${toolName} is disabled for this task` };
    }
    const isRead = READ_TOOLS.has(toolName);
    const isWrite = WRITE_TOOLS.has(toolName);
    if (!isRead && !isWrite) return { block: true, reason: `tool ${toolName} is not allowed` };

    // find's `pattern` and grep's `glob` are file globs; grep's `pattern` is a content regex.
    const globs = [toolName === "find" ? input.pattern : undefined, input.glob];
    for (const value of globs) {
      if (typeof value === "string" && unsafePattern(value)) {
        return { block: true, reason: "file patterns must be relative and stay inside the project" };
      }
    }

    for (const raw of pathArgs(toolName, input)) {
      if (raw === undefined) return { block: true, reason: "path is required" };
      if (typeof raw !== "string" || raw.trim() === "")
        return { block: true, reason: "path must be a string" };
      const target = canonical(resolveToolPath(raw, root));
      if (!isInsideDir(root, target)) {
        return { block: true, reason: `path ${raw} is outside the project directory` };
      }
      const name = basename(target).toLowerCase();
      if (PROTECTED_FILES.includes(name) && (isWrite || !policy.allowProtectedReads)) {
        return { block: true, reason: `${name} is managed by the pipeline; use the scene data in the task` };
      }
      if (isWrite && !writable.has(fold(target))) {
        return {
          block: true,
          reason: `writes are limited to: ${policy.writable.join(", ")}`,
        };
      }
    }
    return { block: false };
  };

  return { root, check };
}

export type PathGuard = ReturnType<typeof createPathGuard>;
