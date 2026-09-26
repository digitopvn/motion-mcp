import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPathGuard, normalizeToolPath } from "../src/path-guard.ts";

const base = mkdtempSync(join(tmpdir(), "pi-guard-test-"));
const projectDir = join(base, "project");
const outside = join(base, "outside");
mkdirSync(join(projectDir, "compositions"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(projectDir, "motion-ir.json"), "{}");
writeFileSync(join(outside, "secret.txt"), "nope");

afterAll(() => rmSync(base, { recursive: true, force: true }));

const guard = createPathGuard({
  projectDir,
  writable: ["compositions/intro.html"],
  passthroughTools: ["submit_scene"],
});
const blocked = (tool: string, input: Record<string, unknown>) => guard.check(tool, input).block;

describe("path guard", () => {
  it("allows reads inside the project and the one writable scene file", () => {
    expect(blocked("read", { path: "compositions/intro.html" })).toBe(false);
    expect(blocked("ls", {})).toBe(false);
    expect(blocked("grep", { pattern: "gsap", path: "compositions" })).toBe(false);
    expect(blocked("find", { pattern: "**/*.html" })).toBe(false);
    expect(blocked("write", { path: "compositions/intro.html", content: "<template></template>" })).toBe(
      false,
    );
    expect(blocked("edit", { path: join(projectDir, "compositions", "intro.html"), edits: [] })).toBe(false);
    expect(blocked("write", { path: "@compositions/intro.html", content: "" })).toBe(false);
  });

  it("blocks paths that resolve outside the project", () => {
    expect(blocked("read", { path: "../outside/secret.txt" })).toBe(true);
    expect(blocked("read", { path: join(outside, "secret.txt") })).toBe(true);
    expect(blocked("read", { path: "~/.ssh/id_rsa" })).toBe(true);
    expect(blocked("ls", { path: ".." })).toBe(true);
    expect(blocked("grep", { pattern: "x", path: "/" })).toBe(true);
    expect(blocked("read", { path: "compositions/../../outside/secret.txt" })).toBe(true);
  });

  it("blocks escaping glob patterns", () => {
    expect(blocked("find", { pattern: "../**/*" })).toBe(true);
    expect(blocked("grep", { pattern: "x", glob: "../../*.env" })).toBe(true);
    expect(blocked("find", { pattern: join(outside, "*") })).toBe(true);
  });

  it("protects pipeline-owned files and limits writes to the scene file", () => {
    expect(blocked("read", { path: "motion-ir.json" })).toBe(true);
    expect(blocked("write", { path: "hyperframes.json", content: "{}" })).toBe(true);
    expect(blocked("write", { path: "compositions/other.html", content: "" })).toBe(true);
    expect(blocked("write", { path: "index.html", content: "" })).toBe(true);
    expect(guard.check("write", { path: "index.html", content: "" }).reason).toMatch(
      /compositions\/intro\.html/,
    );
    const readable = createPathGuard({ projectDir, writable: [], allowProtectedReads: true });
    expect(readable.check("read", { path: "motion-ir.json" }).block).toBe(false);
    expect(readable.check("edit", { path: "motion-ir.json", edits: [] }).block).toBe(true);
  });

  it("blocks bash unless explicitly allowed, and unknown tools always", () => {
    expect(blocked("bash", { command: "ls" })).toBe(true);
    expect(blocked("powershell", { command: "dir" })).toBe(true);
    expect(blocked("web_fetch", { url: "https://x" })).toBe(true);
    expect(blocked("submit_scene", { files: [] })).toBe(false);
    const withBash = createPathGuard({ projectDir, writable: [], allowBash: true });
    expect(withBash.check("bash", { command: "ls" }).block).toBe(false);
  });

  it("follows symlinks that point outside the project", () => {
    const link = join(projectDir, "escape-link");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // symlink creation not permitted on this machine
    }
    expect(blocked("read", { path: "escape-link/secret.txt" })).toBe(true);
  });

  it("mirrors Pi's path normalization", () => {
    expect(normalizeToolPath("@a/b")).toBe("a/b");
    expect(normalizeToolPath("~")).toBe(homedir());
    expect(normalizeToolPath("a\u00A0b")).toBe("a b");
    if (process.platform === "win32") expect(normalizeToolPath("/c/Users/x")).toBe("C:\\Users\\x");
  });
});
