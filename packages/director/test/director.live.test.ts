import { resolve } from "node:path";
import { OpenRouterClient } from "@motion-mcp/llm";
import { compileCreativeSpec, MotionIR } from "@motion-mcp/motion-ir";
import { startTrace, summarize } from "@motion-mcp/observability";
import { loadConfig, loadDotEnv, registerSecretsFromEnv } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import { Director } from "../src/index.ts";

loadDotEnv(resolve(import.meta.dirname, "../../../.env"));
registerSecretsFromEnv();
const config = loadConfig();

const BRIEF =
  "Launch video for Tracewise, a distributed-tracing tool for backend teams. Message: debugging a checkout " +
  "request that touches 47 services stops being archaeology; one trace reads like a sentence. Audience: senior " +
  "backend engineers. Tone: calm, precise, editorial. End with 'Try Tracewise free' and tracewise.dev.";

describe.skipIf(!config.OPENROUTER_API_KEY)("director (live OpenRouter)", () => {
  it("creates a schema-valid CreativeSpec for the product-launch brief and records cost", async () => {
    const gateway = new OpenRouterClient({
      apiKey: config.OPENROUTER_API_KEY!,
      baseUrl: config.OPENROUTER_BASE_URL,
    });
    const director = new Director({ gateway, directorModel: config.DIRECTOR_MODEL });
    const span = startTrace("director.live");
    const result = await director.createCreativeSpec(
      { brief: BRIEF, mode: "internal-opus", format: { aspect: "16:9", fps: 30, duration: 20 } },
      span,
    );
    span.end();
    const ir = compileCreativeSpec(result.spec, { id: "proj_live" });
    expect(MotionIR.safeParse(ir).success).toBe(true);
    const summary = summarize(span.data);
    const call = result.modelCalls.at(-1)!;
    // Only non-secret facts are printed: model, tokens, cost, scene count.
    console.log(
      JSON.stringify({
        model: call.model,
        calls: summary.modelCalls,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cacheReadTokens: summary.cacheReadTokens,
        costUsd: Number(summary.apiCostUsd.toFixed(5)),
        scenes: result.spec.scenes.length,
        durationS: result.spec.scenes.reduce((s, sc) => s + sc.duration, 0),
      }),
    );
    expect(summary.modelCalls).toBeGreaterThanOrEqual(1);
    expect(summary.apiCostUsd).toBeGreaterThan(0);
  });
});
