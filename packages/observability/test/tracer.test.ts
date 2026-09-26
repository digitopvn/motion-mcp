import { describe, expect, it } from "vitest";
import { margin, renderTree, startTrace, summarize } from "../src/index.ts";

describe("tracer", () => {
  it("aggregates model, render and asset costs across the span tree", async () => {
    const root = startTrace("video.generate", { projectId: "proj_1" });
    await root.run("director.opus", async (s) => {
      s.recordModelCall({
        model: "anthropic/claude-opus-5.5",
        provider: "openrouter",
        inputTokens: 2000,
        outputTokens: 1500,
        costUsd: 0.038,
      });
    });
    await root.run("pi.execute", async (s) => {
      await s.run("scene.01", async (scene) => {
        scene.recordModelCall({
          model: "deepseek/deepseek-v4-flash",
          provider: "openrouter",
          inputTokens: 10_000,
          outputTokens: 3000,
          cacheReadTokens: 4000,
          costUsd: 0.0008,
        });
        scene.retry();
      });
    });
    await root.run("final.render", async (s) => {
      s.addCost("render", 0.02);
    });
    await expect(
      root.run("asset.generate", async () => {
        throw new Error("provider down, key sk-or-abcdefghijklmnopqrstuvwxyz");
      }),
    ).rejects.toThrow();
    root.end();

    const sum = summarize(root.data);
    expect(sum.modelCalls).toBe(2);
    expect(sum.opusCalls).toBe(1);
    expect(sum.inputTokens).toBe(12_000);
    expect(sum.cacheReadTokens).toBe(4000);
    expect(sum.retries).toBe(1);
    expect(sum.failures).toBe(1);
    expect(sum.cogsUsd).toBeCloseTo(0.0588, 6);
    expect(sum.costByModel["anthropic/claude-opus-5.5"]).toBeCloseTo(0.038);

    const failed = root.data.children.find((c) => c.name === "asset.generate");
    expect(failed?.error).not.toContain("sk-or-");

    const m = margin(sum, 0.5);
    expect(m.grossMargin).toBeCloseTo((0.5 - 0.0588) / 0.5, 6);
    expect(renderTree(root.data)).toContain("scene.01");
  });
});
