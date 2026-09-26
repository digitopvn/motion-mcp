import { QaIssue } from "@motion-mcp/motion-ir";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/compile.ts";
import { checkProject } from "../src/inspect.ts";
import { lintCompiledProject } from "../src/lint.ts";
import { inferSceneId, normalizeCheckReport, readSceneSpans, type SceneSpan } from "../src/qa.ts";
import { GOLDEN_FIXTURES, goldenIr, tempDir, toolchainStatus } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

async function compiled(name: string): Promise<string> {
  const t = await tempDir(name);
  cleanups.push(t.cleanup);
  return (await compileProject(goldenIr(name), t.dir)).projectDir;
}

const SPANS: SceneSpan[] = [
  { id: "s01-hook", start: 0, duration: 4 },
  { id: "s02-body", start: 4, duration: 6 },
];

describe("lint (in-process @hyperframes/lint)", () => {
  it.each(GOLDEN_FIXTURES)("%s lints with zero errors", async (name) => {
    const report = await lintCompiledProject(await compiled(name));
    expect(report.counts.errors, JSON.stringify(report.issues, null, 1)).toBe(0);
    expect(report.ok).toBe(true);
    for (const issue of report.issues) {
      expect(QaIssue.safeParse(issue).success).toBe(true);
      expect(issue.category).toBe("lint_error");
    }
  });

  it("fails clearly when the project has not been compiled", async () => {
    const t = await tempDir("empty");
    cleanups.push(t.cleanup);
    await expect(lintCompiledProject(t.dir)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("check normalization", () => {
  it("attributes findings to scenes by file, selector, then time", () => {
    expect(inferSceneId(SPANS, { file: "compositions/s02-body.html", time: 1 })).toBe("s02-body");
    expect(inferSceneId(SPANS, { selector: "#m-s01-hook__el-title > span", time: 7 })).toBe("s01-hook");
    expect(inferSceneId(SPANS, { time: 4 })).toBe("s02-body");
    expect(inferSceneId(SPANS, { time: 3.99 })).toBe("s01-hook");
    expect(inferSceneId(SPANS, { time: 99 })).toBe("s02-body");
    expect(inferSceneId(SPANS, { file: "index.html" })).toBeUndefined();
  });

  it("maps runtime, layout and contrast findings to QA issues", () => {
    const report = normalizeCheckReport(
      {
        ok: false,
        lint: { findings: [{ code: "ignored_lint", severity: "error", message: "handled in-process" }] },
        runtime: { findings: [{ code: "console_error", severity: "error", message: "boom", time: 1.2 }] },
        layout: {
          findings: [
            {
              code: "container_overflow",
              severity: "warning",
              time: 5.8,
              firstSeen: 5.5,
              selector: "#m-s02-body__el-code > code",
              message: "Element extends outside a clipping layout container.",
              fixHint: "Resize the child.",
              sourceFile: "compositions/s02-body.html",
            },
            { code: "content_overlap", severity: "warning", time: 2, message: "Two elements overlap." },
          ],
        },
        contrast: {
          findings: [{ code: "contrast_aa_failure", severity: "warning", time: 6, selector: "#x" }],
        },
        motion: { findings: [] },
      },
      SPANS,
    );
    expect(report.issues.map((i) => [i.category, i.severity, i.sceneId])).toEqual([
      ["runtime_error", "error", "s01-hook"],
      ["overflow", "warn", "s02-body"],
      ["collision", "warn", "s01-hook"],
      ["low_contrast", "warn", "s02-body"],
    ]);
    expect(report.ok).toBe(false);
    expect(report.counts).toEqual({ errors: 1, warnings: 3, infos: 0 });
    const overflow = report.issues[1];
    expect(overflow?.evidence).toEqual({
      time: 5.5,
      selector: "#m-s02-body__el-code > code",
      code: "container_overflow",
    });
    expect(overflow?.message).toContain("Fix: Resize the child.");
    for (const issue of report.issues) expect(QaIssue.safeParse(issue).success).toBe(true);
  });

  it("rejects a non-object report", () => {
    expect(() => normalizeCheckReport("nope", SPANS)).toThrow(/not a JSON object/);
  });
});

const tc = await toolchainStatus();

describe.skipIf(!tc.chrome)(
  `check --json (real CLI run)${tc.chrome ? "" : ` [skipped: ${tc.reason}]`}`,
  () => {
    it("normalizes a real check run on the technical-explainer golden", async () => {
      const dir = await compiled("technical-explainer");
      const spans = await readSceneSpans(dir);
      const report = await checkProject(dir);
      expect(report.counts.errors).toBe(0);
      for (const issue of report.issues) {
        expect(QaIssue.safeParse(issue).success).toBe(true);
        expect(issue.source).toBe("check");
        expect(spans.map((s) => s.id)).toContain(issue.sceneId);
      }
    });
  },
);
