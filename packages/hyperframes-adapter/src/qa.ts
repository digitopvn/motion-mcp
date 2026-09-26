import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MotionIR, type QaCategory, type QaIssue } from "@motion-mcp/motion-ir";
import { MotionError } from "@motion-mcp/shared";

/** Scene timing of a compiled project, used to attribute findings to scenes. */
export interface SceneSpan {
  id: string;
  start: number;
  duration: number;
}

/** Load and validate the `motion-ir.json` written by `compileProject`. */
export async function readProjectIr(projectDir: string): Promise<MotionIR> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, "motion-ir.json"), "utf8");
  } catch (err) {
    throw new MotionError("NOT_FOUND", `No motion-ir.json in ${projectDir}; compile the project first`, {
      cause: err,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new MotionError("VALIDATION", "motion-ir.json is not valid JSON", { cause: err });
  }
  const parsed = MotionIR.safeParse(json);
  if (!parsed.success) {
    throw new MotionError(
      "VALIDATION",
      `motion-ir.json does not match MotionIR: ${parsed.error.message.slice(0, 400)}`,
    );
  }
  return parsed.data;
}

/** Read scene spans (root-timeline start and duration) from the compiled project's `motion-ir.json`. */
export async function readSceneSpans(projectDir: string): Promise<SceneSpan[]> {
  const ir = await readProjectIr(projectDir);
  let t = 0;
  return ir.scenes.map((s) => {
    const span = { id: s.id, start: t, duration: s.duration };
    t += s.duration;
    return span;
  });
}

const SOURCE_FILE_RE = /(?:^|[\\/])compositions[\\/]([^\\/]+)\.html$/;
const SELECTOR_SCENE_RE = /#m-([A-Za-z0-9_-]+?)__/;

/**
 * Attribute a finding to a scene: by its source file (`compositions/<id>.html`), then by the
 * scene-scoped DOM id prefix in its selector (`#m-<id>__…`), then by root time.
 */
export function inferSceneId(
  spans: readonly SceneSpan[],
  hint: { file?: string; selector?: string; time?: number },
): string | undefined {
  const known = new Set(spans.map((s) => s.id));
  const fromFile = hint.file?.match(SOURCE_FILE_RE)?.[1];
  if (fromFile && known.has(fromFile)) return fromFile;
  const fromSelector = hint.selector?.match(SELECTOR_SCENE_RE)?.[1];
  if (fromSelector && known.has(fromSelector)) return fromSelector;
  const time = hint.time;
  if (typeof time === "number" && Number.isFinite(time)) {
    const hit = spans.find((s) => time >= s.start && time < s.start + s.duration);
    return (hit ?? (time >= 0 ? spans.at(-1) : spans[0]))?.id;
  }
  return undefined;
}

export function mapSeverity(severity: unknown): QaIssue["severity"] {
  if (severity === "error") return "error";
  if (severity === "warning" || severity === "warn") return "warn";
  return "info";
}

export function clampMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 600 ? `${oneLine.slice(0, 597)}...` : oneLine;
}

const CHECK_CATEGORY: Record<string, QaCategory> = {
  clipped_text: "text_clipping",
  text_box_overflow: "text_clipping",
  caption_text_overflow_risk: "text_clipping",
  caption_overflow_clips_scaled_words: "text_clipping",
  container_overflow: "overflow",
  canvas_overflow: "overflow",
  escaped_container: "overflow",
  panel_out_of_canvas: "overflow",
  frame_out_of_frame: "overflow",
  motion_off_frame: "overflow",
  content_overlap: "collision",
  text_occluded: "collision",
  caption_zone_collision: "collision",
  canvas_content_at_edge: "safe_area",
  contrast_aa_failure: "low_contrast",
  text_not_painted: "unreadable_text",
  motion_appears_late: "timing_mismatch",
  motion_frozen: "timing_mismatch",
  motion_out_of_order: "timing_mismatch",
  missing_local_asset: "broken_image",
  inaccessible_media_url: "broken_image",
  media_missing_src: "broken_image",
};

/** Category for a `hyperframes check` finding, falling back by the report section it came from. */
export function checkCategory(section: CheckSection, code: string): QaCategory {
  const mapped = CHECK_CATEGORY[code];
  if (mapped) return mapped;
  switch (section) {
    case "runtime":
      return "runtime_error";
    case "layout":
      return "overflow";
    case "contrast":
      return "low_contrast";
    case "motion":
      return "timing_mismatch";
  }
}

export type CheckSection = "runtime" | "layout" | "motion" | "contrast";
export const CHECK_SECTIONS: readonly CheckSection[] = ["runtime", "layout", "motion", "contrast"];

/** The subset of a `hyperframes check --json` finding this adapter relies on. */
interface RawCheckFinding {
  code?: unknown;
  severity?: unknown;
  message?: unknown;
  time?: unknown;
  firstSeen?: unknown;
  selector?: unknown;
  sourceFile?: unknown;
  file?: unknown;
  fixHint?: unknown;
}

export interface CheckReport {
  ok: boolean;
  issues: QaIssue[];
  counts: { errors: number; warnings: number; infos: number };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Normalize a `hyperframes check --json` document into QA issues. Lint findings in the report
 * are ignored: lint runs in-process (see `lintCompiledProject`) and would otherwise duplicate.
 */
export function normalizeCheckReport(json: unknown, spans: readonly SceneSpan[]): CheckReport {
  if (typeof json !== "object" || json === null) {
    throw new MotionError("VALIDATION", "hyperframes check output is not a JSON object");
  }
  const doc = json as Record<string, unknown>;
  const issues: QaIssue[] = [];
  for (const section of CHECK_SECTIONS) {
    const block = doc[section] as { findings?: unknown } | undefined;
    if (!block || !Array.isArray(block.findings)) continue;
    for (const raw of block.findings as RawCheckFinding[]) {
      const code = str(raw.code) ?? `${section}_finding`;
      const time = numOrUndef(raw.firstSeen) ?? numOrUndef(raw.time);
      const selector = str(raw.selector);
      const hint = str(raw.fixHint);
      const message = `${str(raw.message) ?? code}${hint ? ` Fix: ${hint}` : ""}`;
      issues.push({
        id: `check-${section}-${String(issues.length + 1).padStart(3, "0")}`,
        sceneId: inferSceneId(spans, { file: str(raw.sourceFile) ?? str(raw.file), selector, time }),
        category: checkCategory(section, code),
        severity: mapSeverity(raw.severity),
        message: clampMessage(`[${code}] ${message}`),
        source: "check",
        evidence: {
          ...(time !== undefined ? { time } : {}),
          ...(selector ? { selector } : {}),
          code,
        },
      });
    }
  }
  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    counts: countSeverities(issues),
  };
}

export function countSeverities(issues: readonly QaIssue[]): CheckReport["counts"] {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warn").length,
    infos: issues.filter((i) => i.severity === "info").length,
  };
}
