import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentEnv, createSandboxSpawn, probeSandbox, sandboxArgv } from "../src/sandbox.ts";

const base = mkdtempSync(join(tmpdir(), "claude-sandbox-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function layout() {
  const projectDir = mkdtempSync(join(base, "project-"));
  const compositions = join(projectDir, "compositions");
  mkdirSync(compositions);
  writeFileSync(join(projectDir, "motion-ir.json"), "{}");
  const homeDir = mkdtempSync(join(base, "home-"));
  return { projectDir, compositions, homeDir };
}

function run(
  spawnFn: ReturnType<typeof createSandboxSpawn>["spawn"],
  script: string,
  env: Record<string, string>,
) {
  const child = spawnFn({
    command: "/bin/sh",
    args: ["-c", script],
    env,
    signal: new AbortController().signal,
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    out += d;
  });
  child.stdin.end();
  return new Promise<{ code: number | null; out: string }>((resolve) =>
    child.once("exit", (code) => resolve({ code, out })),
  );
}

describe("sandboxArgv", () => {
  it("makes the project read-only except the writable dirs and binds a private home", () => {
    const { projectDir, compositions, homeDir } = layout();
    const argv = sandboxArgv(
      {
        mode: "bwrap",
        projectDir,
        writableDirs: [compositions],
        homeDir,
        cpuSeconds: 30,
        maxFileBytes: 1024,
      },
      "/opt/sdk/claude",
      ["--print"],
    ).join(" ");
    expect(argv).toContain("--unshare-all --share-net");
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain(`--ro-bind ${projectDir} ${projectDir}`);
    expect(argv).toContain(`--bind ${compositions} ${compositions}`);
    expect(argv).toContain(`--bind ${homeDir} ${homeDir}`);
    expect(argv).toContain("--ro-bind /opt/sdk /opt/sdk");
    expect(argv).toMatch(/-- \/opt\/sdk\/claude --print$/);
    if (argv.includes("prlimit")) expect(argv).toContain("--cpu=30 --fsize=1024");
  });

  it("runs the command directly (still in its own process group) when the sandbox is off", () => {
    const { projectDir, homeDir } = layout();
    const argv = sandboxArgv({ mode: "none", projectDir, writableDirs: [], homeDir }, "/bin/true", []);
    expect(argv).not.toContain("bwrap");
    expect(argv.at(-1)).toBe("/bin/true");
  });
});

describe("agentEnv", () => {
  it("passes only the workspace key and an isolated config dir", () => {
    process.env.MOTION_TEST_SECRET = "leak";
    const env = agentEnv({ apiKey: "sk-ant-x", homeDir: "/tmp/h" });
    delete process.env.MOTION_TEST_SECRET;
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-x",
      HOME: "/tmp/h",
      CLAUDE_CONFIG_DIR: "/tmp/h/.claude",
    });
    expect(env).not.toHaveProperty("MOTION_TEST_SECRET");
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).not.toHaveProperty("DATABASE_URL");
  });
});

const bwrap = probeSandbox("bwrap");

describe.runIf(bwrap.ok)("bwrap sandbox (host supports user namespaces)", () => {
  it("allows writes only inside the writable dirs and hides the host home", async () => {
    const { projectDir, compositions, homeDir } = layout();
    const sandbox = createSandboxSpawn({ mode: "bwrap", projectDir, writableDirs: [compositions], homeDir });
    const env = { PATH: "/usr/bin:/bin", HOME: homeDir };
    const script = [
      `echo ok > ${compositions}/intro.html && echo scene-ok`,
      `(echo x > ${projectDir}/motion-ir.json) 2>/dev/null || echo ir-blocked`,
      `(echo x > ${projectDir}/new.txt) 2>/dev/null || echo root-blocked`,
      `test -e ${process.env.HOME}/.bashrc && echo home-visible || echo home-hidden`,
    ].join("; ");
    const res = await run(sandbox.spawn, script, env);
    expect(res.out).toContain("scene-ok");
    expect(res.out).toContain("ir-blocked");
    expect(res.out).toContain("root-blocked");
    expect(res.out).not.toContain("home-visible");
    expect(readFileSync(join(compositions, "intro.html"), "utf8")).toBe("ok\n");
    expect(readFileSync(join(projectDir, "motion-ir.json"), "utf8")).toBe("{}");
  });

  it("kills the whole process tree on abort", async () => {
    const { projectDir, compositions, homeDir } = layout();
    const sandbox = createSandboxSpawn({ mode: "bwrap", projectDir, writableDirs: [compositions], homeDir });
    const controller = new AbortController();
    const child = sandbox.spawn({
      command: "/bin/sh",
      args: ["-c", "sleep 30 & sleep 30; echo done"],
      env: { PATH: "/usr/bin:/bin" },
      signal: controller.signal,
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await exited;
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
