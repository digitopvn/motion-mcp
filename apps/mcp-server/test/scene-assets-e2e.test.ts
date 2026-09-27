import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHyperframesAdapter } from "@motion-mcp/hyperframes-adapter";
import type { MediaCommandRunner, MultixRunRequest, MultixRunResult } from "@motion-mcp/media";
import type { MediaRuntime } from "@motion-mcp/pipeline";
import { afterEach, describe, expect, it } from "vitest";
import { callOk, type Harness, startHarness, waitForJob } from "./harness.ts";

const SPEC_PATH = resolve(import.meta.dirname, "../../../fixtures/golden/product-launch/creative-spec.json");
const BRIEF = "Launch video for Tracewise, a distributed tracing tool, for backend engineers.";
const ENCRYPTION_KEY = "5f".repeat(32);
/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const doctor = await createHyperframesAdapter().doctor({ ensureBrowser: false });
const canRender = doctor.hyperframes.ok && doctor.chrome.ok && doctor.ffmpeg.ok;

/** The golden spec with the CTA logo drawn from a generated image. */
function specWithGeneratedLogo(): Record<string, unknown> {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
    scenes: Array<{ id: string; assetNeeds?: unknown[]; elements: Array<Record<string, unknown>> }>;
  };
  const cta = spec.scenes.find((s) => s.id === "s06-cta");
  if (!cta) throw new Error("fixture has no s06-cta scene");
  cta.assetNeeds = [
    {
      id: "logo-mark",
      kind: "logo",
      description: "A trace waterfall folded into a single mark",
      source: "generate",
      required: true,
    },
  ];
  const logo = cta.elements.find((e) => e.id === "logo");
  if (logo) logo.asset = "logo-mark";
  return spec as unknown as Record<string, unknown>;
}

/** Writes a PNG wherever multix is told to, and records which keys each call carried. */
class FakeMultix implements MediaCommandRunner {
  readonly calls: MultixRunRequest[] = [];
  async run(request: MultixRunRequest): Promise<MultixRunResult> {
    this.calls.push(request);
    const i = request.argv.indexOf("--output");
    const file = request.argv[i + 1] as string;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, PNG);
    return { argv: request.argv, exitCode: 0, files: [file], stdout: "", stderr: "", durationMs: 1 };
  }
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function createAndWait(h: Harness) {
  const client = await h.connect();
  const created = await callOk<{ projectId: string; jobId: string }>(client, "motion_create", {
    brief: BRIEF,
    creativeSpec: specWithGeneratedLogo(),
    durationSeconds: 6,
  });
  const view = await waitForJob(client, created.projectId, created.jobId, ["succeeded"], 200_000, ["usage"]);
  const images = view.usage?.breakdown.filter((b) => b.operation === "image_generation") ?? [];
  return { view, images, projectDir: join(h.rt.workDir, created.projectId, "v1") };
}

async function compiledReferences(projectDir: string): Promise<string[]> {
  const generated = join(projectDir, "assets", "generated");
  if (!existsSync(generated)) return [];
  const files = await readdir(generated);
  const html = await readFile(join(projectDir, "compositions", "s06-cta.html"), "utf8");
  return files.filter((f) => html.includes(`assets/generated/${f}`));
}

describe.skipIf(!canRender)("scene image generation", { timeout: 240_000 }, () => {
  it("generates a server-paid image, bills it, and compiles it into the scene", async () => {
    const runner = new FakeMultix();
    const media: MediaRuntime = { runner, serverEnv: { OPENROUTER_API_KEY: "or-server-test-key-123456" } };
    harness = await startHarness({}, { media });
    const { images, projectDir } = await createAndWait(harness);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.argv[0]).toBe("openrouter");
    expect(runner.calls[0]?.argv).toContain("--aspect-ratio=1:1");
    expect(images).toEqual([expect.objectContaining({ quantity: 1, credits: 10 })]);
    expect(await compiledReferences(projectDir)).toHaveLength(1);
    // The reservation covered the whole allowance; only the image that was made is charged.
    const balance = await harness.rt.ledger.balance("ws_default");
    expect(balance.held).toBe(0);
  });

  it("uses the workspace's own image key first and charges no credits for it", async () => {
    const runner = new FakeMultix();
    const media: MediaRuntime = { runner, serverEnv: { OPENROUTER_API_KEY: "or-server-test-key-123456" } };
    harness = await startHarness({ CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY }, { media });
    await harness.rt.providers.setMultixKey("ws_default", "GEMINI_API_KEY", "gemini-workspace-key-123456");
    const { images, projectDir } = await createAndWait(harness);

    expect(runner.calls.map((c) => c.argv[0])).toEqual(["gemini"]);
    expect(runner.calls[0]?.providerEnv).toEqual({ GEMINI_API_KEY: "gemini-workspace-key-123456" });
    expect(images).toEqual([expect.objectContaining({ quantity: 1, credits: 0 })]);
    expect(await compiledReferences(projectDir)).toHaveLength(1);
  });

  it("renders a placeholder and warns when no image key is available", async () => {
    const runner = new FakeMultix();
    harness = await startHarness({}, { media: { runner, serverEnv: {} } });
    const { view, images, projectDir } = await createAndWait(harness);

    expect(runner.calls).toHaveLength(0);
    expect(images).toEqual([]);
    expect(view.job?.message).toContain("no image provider key");
    expect(await compiledReferences(projectDir)).toEqual([]);
  });
});
