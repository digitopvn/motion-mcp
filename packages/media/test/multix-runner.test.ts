import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildMultixEnv,
  existingOutputs,
  MultixRunner,
  parseOutputPaths,
  resolveMultixLaunch,
} from "../src/multix-runner.ts";

const root = mkdtempSync(join(tmpdir(), "multix-runner-test-"));
const outputDir = join(root, "out dir");
const fakeCli = join(root, "fake-cli.mjs");

beforeAll(() => {
  mkdirSync(outputDir, { recursive: true });
  // A stand-in CLI with multix's stdout shape: writes --output (or a default file) and records its env/cwd.
  writeFileSync(
    fakeCli,
    `import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const outDir = process.env.MULTIX_OUTPUT_DIR;
writeFileSync(join(outDir, "env.json"), JSON.stringify({ env: process.env, cwd: process.cwd(), argv }));
if (argv.includes("--fail")) { console.error("Error: provider said no " + (process.env.GEMINI_API_KEY ?? "")); process.exit(1); }
if (argv.includes("--nothing")) { console.log("done"); process.exit(0); }
const i = argv.indexOf("--output");
const file = i >= 0 ? argv[i + 1] : join(outDir, "auto-name.mp4");
mkdirSync(outDir, { recursive: true });
writeFileSync(file, "data");
console.log("Generated 1 image(s):");
console.log("  " + file);
`,
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseOutputPaths", () => {
  it.skipIf(process.platform !== "win32")(
    "finds Windows paths under the output dir even when they contain spaces",
    () => {
      const dir = "C:\\Users\\John Doe\\out";
      const stdout =
        "\u001b[32mGenerated 2 image(s):\u001b[0m\n  C:\\Users\\John Doe\\out\\a b.png\n  C:\\Users\\John Doe\\out\\c.webp.\n";
      const paths = parseOutputPaths(stdout, dir);
      expect(paths.map((p) => p.replaceAll("/", "\\").toLowerCase())).toEqual([
        "c:\\users\\john doe\\out\\a b.png",
        "c:\\users\\john doe\\out\\c.webp",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "finds POSIX paths under the output dir even when they contain spaces",
    () => {
      const dir = "/home/john doe/out";
      const stdout =
        "\u001b[32mGenerated 2 image(s):\u001b[0m\n  /home/john doe/out/a b.png\n  /home/john doe/out/c.webp.\n";
      expect(parseOutputPaths(stdout, dir)).toEqual([
        "/home/john doe/out/a b.png",
        "/home/john doe/out/c.webp",
      ]);
    },
  );

  it("falls back to generic absolute paths with an extension", () => {
    const paths = parseOutputPaths("Saved video to /data/media/clip.mp4 (12 MB)\nno path here", "/elsewhere");
    expect(paths.map((p) => p.replaceAll("\\", "/"))).toEqual([
      expect.stringMatching(/\/data\/media\/clip\.mp4$/),
    ]);
  });

  it("existingOutputs drops files outside the output dir and missing files", () => {
    const inside = join(outputDir, "exists.png");
    writeFileSync(inside, "x");
    const outside = join(root, "outside.png");
    writeFileSync(outside, "x");
    expect(existingOutputs([inside, outside, join(outputDir, "missing.png")], outputDir)).toEqual([inside]);
  });
});

describe("buildMultixEnv", () => {
  it("passes only essentials, the provider keys and multix switches", () => {
    process.env.MOTION_TEST_UNRELATED_SECRET = "sk-unrelated-secret-value-123456";
    process.env.OPENROUTER_API_KEY_TEST_ONLY = "should-not-pass";
    try {
      const env = buildMultixEnv({ GEMINI_API_KEY: "g-key-12345678" }, outputDir);
      expect(env.GEMINI_API_KEY).toBe("g-key-12345678");
      expect(env.MULTIX_DISABLE_HOME_ENV).toBe("1");
      expect(env.MULTIX_OUTPUT_DIR).toBe(outputDir);
      expect(env.MOTION_TEST_UNRELATED_SECRET).toBeUndefined();
      expect(env.OPENROUTER_API_KEY_TEST_ONLY).toBeUndefined();
      for (const key of Object.keys(env)) expect(key).not.toMatch(/DATABASE|R2_|MOTION_API|TYPESAFE/);
    } finally {
      delete process.env.MOTION_TEST_UNRELATED_SECRET;
      delete process.env.OPENROUTER_API_KEY_TEST_ONLY;
    }
  });
});

describe("resolveMultixLaunch", () => {
  it("finds the pinned CLI and runs it with the current Node", () => {
    const launch = resolveMultixLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.prefixArgs[0]?.replaceAll("\\", "/")).toMatch(/@mrgoonie\/multix\/dist\/cli\.js$/);
  });

  it("honours MULTIX_BIN for a js entry or a command name", () => {
    expect(resolveMultixLaunch("/opt/multix/cli.js").command).toBe(process.execPath);
    expect(resolveMultixLaunch("multix")).toEqual({ command: "multix", prefixArgs: [] });
  });
});

describe("MultixRunner", () => {
  const runner = new MultixRunner({ launch: { command: process.execPath, prefixArgs: [fakeCli] } });
  const readRecord = () =>
    JSON.parse(readFileSync(join(outputDir, "env.json"), "utf8")) as {
      env: Record<string, string>;
      cwd: string;
      argv: string[];
    };

  it("runs with a throwaway cwd, scrubbed env and returns existing output files", async () => {
    process.env.MOTION_TEST_LEAK = "leak-value-abcdefgh";
    try {
      const output = join(outputDir, "img.png");
      const result = await runner.run({
        argv: ["gemini", "generate", "--prompt=a red cube", "--output", output],
        providerEnv: { GEMINI_API_KEY: "gemini-test-key-123" },
        outputDir,
      });
      expect(result.files).toEqual([output]);
      const record = readRecord();
      expect(record.env.GEMINI_API_KEY).toBe("gemini-test-key-123");
      expect(record.env.MOTION_TEST_LEAK).toBeUndefined();
      expect(record.env.MULTIX_DISABLE_HOME_ENV).toBe("1");
      expect(record.cwd).not.toBe(process.cwd());
      expect(record.cwd).toMatch(/motion-multix-/);
      expect(record.argv).toEqual(["gemini", "generate", "--prompt=a red cube", "--output", output]);
    } finally {
      delete process.env.MOTION_TEST_LEAK;
    }
  });

  it("parses stdout when no --output is given", async () => {
    const result = await runner.run({ argv: ["fal", "video", "--", "waves"], providerEnv: {}, outputDir });
    expect(result.files).toEqual([join(outputDir, "auto-name.mp4")]);
  });

  it("throws a redacted provider error on non-zero exit", async () => {
    const run = runner.run({
      argv: ["gemini", "generate", "--fail"],
      providerEnv: { GEMINI_API_KEY: "gemini-secret-value-xyz" },
      outputDir,
    });
    await expect(run).rejects.toMatchObject({ code: "PROVIDER", retryable: true });
    await expect(run).rejects.toThrow(/provider said no \[redacted\]/);
  });

  it("fails when success is reported without a file", async () => {
    await expect(
      runner.run({ argv: ["gemini", "generate", "--nothing"], providerEnv: {}, outputDir }),
    ).rejects.toThrow(/produced no file/);
  });

  it("refuses multix check and update", async () => {
    await expect(runner.run({ argv: ["check", "-v"], providerEnv: {}, outputDir })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      runner.run({ argv: ["update", "--check"], providerEnv: {}, outputDir }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
