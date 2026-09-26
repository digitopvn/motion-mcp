import { join, resolve } from "node:path";
import { startTrace, summarize } from "@motion-mcp/observability";
import { MotionError } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import { CAPABILITY_MATRIX, Capability, type ProviderRoute } from "../src/capability-matrix.ts";
import type { MediaCommandRunner, MultixRunRequest, MultixRunResult } from "../src/multix-runner.ts";
import { estimateAssetCost, findPrice, PRICE_TABLE } from "../src/prices.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";

const outputDir = resolve("/tmp/motion-media-test");

/** Records every request; fails for the providers listed in `failFor`. */
class FakeRunner implements MediaCommandRunner {
  readonly calls: MultixRunRequest[] = [];
  constructor(private readonly failFor: string[] = []) {}
  async run(request: MultixRunRequest): Promise<MultixRunResult> {
    this.calls.push(request);
    const provider = request.argv[0] ?? "";
    if (this.failFor.includes(provider)) {
      throw new MotionError("PROVIDER", `${provider} unavailable`, { retryable: true });
    }
    const i = request.argv.indexOf("--output");
    const file = i >= 0 ? (request.argv[i + 1] as string) : join(request.outputDir, "parsed.mp4");
    return { argv: request.argv, exitCode: 0, files: [file], stdout: "", stderr: "", durationMs: 5 };
  }
}

const route = (cap: Capability, provider: string): ProviderRoute => {
  const r = CAPABILITY_MATRIX[cap].find((x) => x.provider === provider);
  if (!r) throw new Error(`no ${provider} route for ${cap}`);
  return r;
};

describe("CAPABILITY_MATRIX argv builders", () => {
  const output = join(outputDir, "a.png");

  it("covers every capability with at least one route", () => {
    for (const cap of Capability.options) expect(CAPABILITY_MATRIX[cap].length).toBeGreaterThan(0);
  });

  it("builds gemini image argv with --flag=value text and explicit output", () => {
    const argv = route("image.generate", "gemini").buildArgv({
      prompt: "--rm -rf a cube",
      params: { aspectRatio: "9:16" },
      output,
      model: "gemini-2.5-flash-image",
    });
    expect(argv).toEqual([
      "gemini",
      "generate",
      "--prompt=--rm -rf a cube",
      "--aspect-ratio=9:16",
      "--image-format=original",
      "--output",
      output,
    ]);
  });

  it("builds openai, openrouter and fal image argv", () => {
    expect(
      route("image.generate", "openai").buildArgv({ prompt: "p", params: {}, output, model: "gpt-image-2" }),
    ).toEqual([
      "openai",
      "generate",
      "--driver=api",
      "--prompt=p",
      "--model=gpt-image-2",
      "--size=1536x1024",
      "--quality=medium",
      "--image-format=original",
      "--output",
      output,
    ]);
    expect(
      route("image.generate", "openrouter").buildArgv({ prompt: "p", params: {}, output, model: "google/x" }),
    ).toContain("--model=google/x");
    const fal = route("image.generate", "fal").buildArgv({
      prompt: "-p",
      params: {},
      output,
      model: "fal-ai/flux/schnell",
    });
    expect(fal.slice(-2)).toEqual(["--", "-p"]);
  });

  it("maps video params per provider", () => {
    const minimax = route("video.t2v", "minimax").buildArgv({
      prompt: "waves",
      params: { durationSeconds: 9, resolution: "720p" },
      output: join(outputDir, "v.mp4"),
      model: "MiniMax-Hailuo-2.3",
    });
    expect(minimax).toContain("--duration=10");
    expect(minimax).toContain("--resolution=720P");
    const byteplus = route("video.t2v", "byteplus").buildArgv({
      prompt: "waves",
      params: { durationSeconds: 30 },
      output: join(outputDir, "v.mp4"),
      model: "seedance-2.0",
    });
    expect(byteplus).toContain("--duration=15");
    expect(byteplus).toContain("--no-audio");
    const fal = route("video.t2v", "fal").buildArgv({ prompt: "waves", params: {}, output: "", model: "m" });
    expect(fal).not.toContain("--output");
  });

  it("requires source inputs for edit, i2v, stt and upscale", () => {
    const base = { prompt: "p", params: {}, output, model: "m" };
    expect(() => route("image.edit", "gemini").buildArgv(base)).toThrow(/inputImage/);
    expect(() => route("audio.stt", "openai").buildArgv(base)).toThrow(/inputFile/);
    expect(() =>
      route("video.i2v", "minimax").buildArgv({ ...base, params: { inputImage: "/local/file.png" } }),
    ).toThrow(/https URL/);
    expect(
      route("image.upscale", "fal").buildArgv({ ...base, params: { inputImage: "https://x.test/a.png" } }),
    ).toEqual(["fal", "run", '--input={"image_url":"https://x.test/a.png"}', "--", "m"]);
  });

  it("builds tts and sfx argv", () => {
    const tts = route("audio.tts", "elevenlabs").buildArgv({
      prompt: "Hello there",
      params: { voice: "abc123", language: "en" },
      output: join(outputDir, "vo.mp3"),
      model: "eleven_multilingual_v2",
    });
    expect(tts).toEqual([
      "elevenlabs",
      "tts",
      "--text=Hello there",
      "--model=eleven_multilingual_v2",
      "--voice=abc123",
      "--language-code=en",
      "--output",
      join(outputDir, "vo.mp3"),
    ]);
    const sfx = route("audio.sfx", "elevenlabs").buildArgv({
      prompt: "whoosh",
      params: { durationSeconds: 90 },
      output: join(outputDir, "s.mp3"),
      model: "sound-effects",
    });
    expect(sfx).toContain("--duration-seconds=30");
  });
});

describe("ProviderRegistry", () => {
  const env = {
    GEMINI_API_KEY: "gemini-key-123456",
    OPENAI_API_KEY: "openai-key-123456",
    OPENROUTER_API_KEY: "or-key-123456",
    DATABASE_URL: "postgres://secret",
    CLOUDFLARE_API_TOKEN: "cf-token-without-account",
  };

  it("filters capabilities by key presence", () => {
    const registry = new ProviderRegistry({ runner: new FakeRunner(), env, outputDir });
    expect(registry.available("image.generate").map((r) => r.provider)).toEqual([
      "gemini",
      "openai",
      "openrouter",
    ]);
    expect(registry.available("audio.sfx")).toEqual([]);
    expect(registry.available("audio.sfx", { ELEVENLABS_API_KEY: "el-key-123456" })).toHaveLength(1);
    expect(registry.describe()["audio.tts"]).toEqual(["openai", "gemini"]);
  });

  it("orders preferred providers first and forwards only that provider's keys", async () => {
    const runner = new FakeRunner();
    const registry = new ProviderRegistry({ runner, env, outputDir });
    const asset = await registry.generateAsset({
      capability: "image.generate",
      prompt: "a cube",
      preferProviders: ["openrouter"],
      name: "hero-image",
    });
    expect(asset.provider).toBe("openrouter");
    expect(asset.files).toEqual([join(outputDir, "hero-image.png")]);
    expect(runner.calls[0]?.providerEnv).toEqual({ OPENROUTER_API_KEY: "or-key-123456" });
  });

  it("falls back across providers in order and records costs on spans", async () => {
    const runner = new FakeRunner(["gemini", "openai"]);
    const registry = new ProviderRegistry({ runner, env, outputDir });
    const root = startTrace("test");
    const asset = await registry.generateAsset({ capability: "image.generate", prompt: "a cube" }, root);
    root.end();
    expect(runner.calls.map((c) => c.argv[0])).toEqual(["gemini", "openai", "openrouter"]);
    expect(asset.provider).toBe("openrouter");
    expect(asset.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["gemini", false],
      ["openai", false],
      ["openrouter", true],
    ]);
    const summary = summarize(root.data);
    expect(summary.assetCostUsd).toBeCloseTo(0.039, 6);
    expect(summary.failures).toBe(2);
    expect(summary.retries).toBe(2);
  });

  it("uses per-provider model overrides", async () => {
    const runner = new FakeRunner();
    const registry = new ProviderRegistry({ runner, env, outputDir });
    const asset = await registry.generateAsset({
      capability: "image.generate",
      prompt: "x",
      models: { gemini: "gemini-3-pro-image" },
    });
    expect(asset.model).toBe("gemini-3-pro-image");
    expect(runner.calls[0]?.argv).toContain("--model=gemini-3-pro-image");
  });

  it("throws PROVIDER with attempts when every provider fails, CONFIG when none is available", async () => {
    const registry = new ProviderRegistry({ runner: new FakeRunner(["gemini", "openai"]), env, outputDir });
    await expect(registry.generateAsset({ capability: "audio.tts", prompt: "hi" })).rejects.toMatchObject({
      code: "PROVIDER",
      details: { attempts: [{ provider: "openai" }, { provider: "gemini" }] },
    });
    await expect(registry.generateAsset({ capability: "audio.music", prompt: "lofi" })).rejects.toMatchObject(
      {
        code: "CONFIG",
      },
    );
  });

  it("validates requests at the boundary", async () => {
    const registry = new ProviderRegistry({ runner: new FakeRunner(), env, outputDir });
    await expect(
      registry.generateAsset({ capability: "image.generate", prompt: "x", params: { aspectRatio: "wide" } }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      registry.generateAsset({ capability: "image.generate", prompt: "x", name: "../escape" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(
      () => new ProviderRegistry({ runner: new FakeRunner(), env, outputDir: "relative/dir" }),
    ).toThrow();
  });
});

describe("prices", () => {
  it("marks every entry indicative and has a price for every default route", () => {
    for (const entry of PRICE_TABLE) expect(entry.indicative).toBe(true);
    for (const cap of Capability.options) {
      for (const r of CAPABILITY_MATRIX[cap]) {
        expect(findPrice(r.provider, r.defaultModel, r.unit), `${cap}/${r.provider}`).toBeDefined();
      }
    }
  });

  it("estimates by unit and quantity", () => {
    expect(
      estimateAssetCost({ provider: "gemini", model: "veo", unit: "video_second", quantity: 8 }).usd,
    ).toBeCloseTo(3.2, 6);
    const unknown = estimateAssetCost({ provider: "nobody", model: "x", unit: "image", quantity: 1 });
    expect(unknown).toMatchObject({ usd: 0, priced: false });
  });
});
