import { lintProject } from "@hyperframes/lint";
import type { QaIssue } from "@motion-mcp/motion-ir";
import { MotionError } from "@motion-mcp/shared";
import {
  type CheckReport,
  clampMessage,
  countSeverities,
  inferSceneId,
  mapSeverity,
  readSceneSpans,
} from "./qa.ts";

export type LintReport = CheckReport;

/**
 * Lint a compiled project in-process with `@hyperframes/lint` and normalize the findings.
 * Every finding is category `lint_error`; severity carries the linter's error/warning/info.
 */
export async function lintCompiledProject(projectDir: string): Promise<LintReport> {
  const spans = await readSceneSpans(projectDir);
  let result: Awaited<ReturnType<typeof lintProject>>;
  try {
    result = await lintProject(projectDir);
  } catch (err) {
    throw new MotionError(
      "LINT",
      `HyperFrames lint failed: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }
  const issues: QaIssue[] = [];
  for (const { file, result: fileResult } of result.results) {
    for (const f of fileResult.findings) {
      const selector = f.selector ?? (f.elementId ? `#${f.elementId}` : undefined);
      const location = f.line ? ` (${file}:${f.line})` : ` (${file})`;
      issues.push({
        id: `lint-${String(issues.length + 1).padStart(3, "0")}`,
        sceneId: inferSceneId(spans, { file: f.file ?? file, selector }),
        category: "lint_error",
        severity: mapSeverity(f.severity),
        message: clampMessage(`[${f.code}] ${f.message}${location}${f.fixHint ? ` Fix: ${f.fixHint}` : ""}`),
        source: "lint",
        evidence: { ...(selector ? { selector } : {}), code: f.code },
      });
    }
  }
  const counts = countSeverities(issues);
  return { ok: counts.errors === 0, issues, counts };
}
