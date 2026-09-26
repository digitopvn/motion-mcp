import type { QaIssue } from "@motion-mcp/motion-ir";
import { describe, expect, it } from "vitest";
import {
  buildPatchPrompt,
  buildScenePrompt,
  estimateTokens,
  MAX_TASK_PROMPT_TOKENS,
  WORKER_SYSTEM_PROMPT,
} from "../src/prompt-builder.ts";
import { context, scene } from "./fixtures.ts";

describe("buildScenePrompt", () => {
  it("contains the target file, contract, context and scene IR", () => {
    const p = buildScenePrompt({
      sceneId: "intro",
      sceneIR: scene,
      context,
      skills: ["Use mask reveals sparingly."],
    });
    expect(p.text).toContain("compositions/intro.html");
    expect(p.text).toContain("window.__timelines");
    expect(p.text).toContain('"accent":"#22d3ee"');
    expect(p.text).toContain('"id":"intro"');
    expect(p.text).toContain("Use mask reveals sparingly.");
    expect(p.text).toContain("Title is readable for at least 2 seconds");
    expect(p.trimmedSnippets).toBe(0);
  });

  it("stays under the token budget with oversized domain-pack snippets", () => {
    const huge = Array.from({ length: 12 }, (_, i) => `Snippet ${i} `.repeat(900));
    const p = buildScenePrompt({ sceneId: "intro", sceneIR: scene, context, skills: huge });
    expect(p.estimatedTokens).toBeLessThanOrEqual(MAX_TASK_PROMPT_TOKENS);
    expect(p.trimmedSnippets).toBeGreaterThan(0);
    expect(p.text).toContain("Snippet 0");
    // Required sections always survive trimming.
    expect(p.text).toContain("## Scene IR");
    expect(p.text).toContain("## Acceptance");
  });

  it("never includes secrets or the system prompt", () => {
    const p = buildScenePrompt({ sceneId: "intro", sceneIR: scene });
    expect(p.text).not.toMatch(/sk-or-|OPENROUTER_API_KEY/);
    expect(p.text).not.toContain(WORKER_SYSTEM_PROMPT);
    expect(estimateTokens(WORKER_SYSTEM_PROMPT)).toBeLessThan(300);
  });
});

describe("buildPatchPrompt", () => {
  const issue = (i: number, severity: QaIssue["severity"]): QaIssue => ({
    id: `q${i}`,
    sceneId: "intro",
    category: "overflow",
    severity,
    message: `Element overflows by ${i}px`,
    source: "check",
    evidence: { time: 1.5, selector: "#title" },
  });

  it("lists instructions and QA issues with errors first", () => {
    const p = buildPatchPrompt({
      sceneId: "intro",
      patch: {
        sceneId: "intro",
        source: "opus",
        rationale: "Title feels rushed",
        changes: [
          { type: "motion", target: "title", instruction: "Slow the title reveal to feel deliberate" },
        ],
      },
      qaIssues: [issue(1, "warn"), issue(2, "error")],
    });
    expect(p.text).toContain("Read compositions/intro.html");
    expect(p.text).toContain("1. [motion @title] Slow the title reveal");
    expect(p.text).toContain("Rationale: Title feels rushed");
    expect(p.text.indexOf("ERROR overflow")).toBeLessThan(p.text.indexOf("WARN overflow"));
    expect(p.text).toContain("t=1.5s selector=#title");
  });

  it("caps QA issues and stays within budget", () => {
    const issues = Array.from({ length: 60 }, (_, i) => issue(i, "warn"));
    const p = buildPatchPrompt({ sceneId: "intro", qaIssues: issues, sceneIR: scene, context });
    expect(p.text).toContain("(40 lower-priority issues omitted)");
    expect(p.estimatedTokens).toBeLessThanOrEqual(MAX_TASK_PROMPT_TOKENS);
  });
});
