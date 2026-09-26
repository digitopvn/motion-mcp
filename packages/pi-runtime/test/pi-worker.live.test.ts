import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderTree, startTrace, summarize } from "@motion-mcp/observability";
import { loadConfig, loadDotEnv } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import { PiWorker } from "../src/pi-worker.ts";
import { context, scene } from "./fixtures.ts";

loadDotEnv(resolve(import.meta.dirname, "../../../.env"));
const config = loadConfig();

describe.skipIf(!config.OPENROUTER_API_KEY)("PiWorker live (OpenRouter CODER_MODEL)", () => {
  it("builds one HyperFrames scene with the real coder model", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pi-live-"));
    mkdirSync(join(projectDir, "compositions"));
    try {
      const worker = await PiWorker.fromConfig(config, { timeoutMs: 8 * 60 * 1000 });
      const root = startTrace("live.pi");
      const result = await worker.buildScene({
        projectDir,
        sceneId: "intro",
        sceneIR: scene,
        context,
        span: root,
      });
      root.end();
      const htmlText = readFileSync(join(projectDir, "compositions", "intro.html"), "utf8");
      const summary = summarize(root.data);
      process.stderr.write(
        `${renderTree(root.data)}\nturns=${result.counters.turns} tools=${result.counters.toolCalls} ` +
          `in=${summary.inputTokens} out=${summary.outputTokens} cost=$${summary.apiCostUsd.toFixed(5)}\n`,
      );
      expect(result.files).toEqual(["compositions/intro.html"]);
      expect(htmlText).toContain("data-composition-id");
      expect(htmlText).toContain("__timelines");
      expect(summary.modelCalls).toBeGreaterThan(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
