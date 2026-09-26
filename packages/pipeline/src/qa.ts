import { readFile, stat } from "node:fs/promises";
import { chat, type ModelGateway } from "@motion-mcp/llm";
import {
  type MotionIR,
  type MotionScene,
  type QaCategory,
  type QaIssue,
  type ScenePatch,
  SizeToken,
} from "@motion-mcp/motion-ir";
import type { Span } from "@motion-mcp/observability";
import type { Logger } from "@motion-mcp/shared";
import { z } from "zod";

/** Inputs a QA pass may look at after lint and check. Frame paths are local files in the work dir. */
export interface QaContext {
  ir: MotionIR;
  projectDir: string;
  contactSheetPath: string;
  loop: number;
  span: Span;
  signal?: AbortSignal;
}

/** A pluggable QA pass (vision model, heuristics, tests). Returns normalized issues; never throws for "no findings". */
export interface QaSource {
  readonly name: string;
  inspect(ctx: QaContext): Promise<QaIssue[]>;
}

const VISION_CATEGORIES = [
  "creative",
  "unreadable_text",
  "low_contrast",
  "misalignment",
  "collision",
  "empty_frame",
  "overflow",
  "text_clipping",
  "safe_area",
] as const satisfies readonly QaCategory[];

const VisionReport = z.object({
  issues: z
    .array(
      z.object({
        sceneId: z.string().max(64),
        category: z.enum(VISION_CATEGORIES),
        severity: z.enum(["info", "warn", "error"]),
        message: z.string().min(1).max(400),
      }),
    )
    .max(12),
});

const VISION_SYSTEM_PROMPT = [
  "You are a strict QA reviewer for motion-design videos.",
  "You see a contact sheet: one row per scene, top to bottom, frames taken at each scene's held moment.",
  "Report only visible problems: clipped or overflowing text, collisions, unreadable or low-contrast text,",
  "empty frames, broken alignment, content outside the safe area, or a creative problem where the frame",
  "clearly contradicts the scene intent. Use severity error only for defects a viewer would notice at once.",
  "Return an empty issues array when the frames look correct. JSON only.",
].join("\n");

const MAX_SHEET_BYTES = 8 * 1024 * 1024;

/**
 * Cheap vision QA over the contact sheet: one structured call per revision loop with the configured
 * VISION_MODEL. Failures are traced and skipped: QA must never fail a job that lint/check accepted.
 */
export function createVisionQaSource(options: {
  gateway: ModelGateway;
  model: string;
  logger?: Logger;
}): QaSource {
  return {
    name: "vision",
    async inspect(ctx) {
      try {
        return await ctx.span.run(
          "vision.qa",
          async (span) => {
            const info = await stat(ctx.contactSheetPath);
            if (info.size > MAX_SHEET_BYTES) {
              span.setAttributes({ "vision.skipped": "contact sheet too large" });
              return [];
            }
            const image = (await readFile(ctx.contactSheetPath)).toString("base64");
            const rows = ctx.ir.scenes.map((s, i) => `${i + 1}. ${s.id} (${s.role}): ${s.intent}`).join("\n");
            const result = await chat(options.gateway, {
              model: options.model,
              messages: [
                { role: "system", content: VISION_SYSTEM_PROMPT },
                {
                  role: "user",
                  content: [
                    { type: "text", text: `Scenes (rows, top to bottom):\n${rows}` },
                    { type: "image", url: `data:image/png;base64,${image}` },
                  ],
                },
              ],
              responseSchema: { name: "qa_report", schema: VisionReport },
              maxTokens: 1200,
              temperature: 0,
              signal: ctx.signal,
              span,
            });
            const known = new Set(ctx.ir.scenes.map((s) => s.id));
            const issues = (result.parsed?.issues ?? [])
              .filter((i) => known.has(i.sceneId))
              .map(
                (i, n): QaIssue => ({
                  id: `vision-${ctx.loop}-${n}`,
                  sceneId: i.sceneId,
                  category: i.category,
                  severity: i.severity,
                  message: i.message,
                  source: "vision",
                }),
              );
            span.setAttributes({ "vision.issues": issues.length, "vision.model": options.model });
            return issues;
          },
          { "qa.loop": ctx.loop },
        );
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        options.logger?.warn("vision.qa.failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },
  };
}

const SIZES = SizeToken.options;

function elementFromSelector(selector: string | undefined, sceneId: string): string | undefined {
  if (!selector) return undefined;
  const marker = `m-${sceneId}__el-`;
  const at = selector.indexOf(marker);
  if (at < 0) return undefined;
  return selector.slice(at + marker.length).match(/^[a-z0-9][a-z0-9-]*/)?.[0];
}

function largestTextElement(scene: MotionScene) {
  return (
    scene.elements.find((e) => e.role === "hero" && e.kind !== "shape" && e.kind !== "image") ??
    scene.elements.find((e) => e.kind === "text")
  );
}

const SHRINK_CATEGORIES: ReadonlySet<QaCategory> = new Set([
  "overflow",
  "text_clipping",
  "collision",
  "safe_area",
]);

/**
 * Deterministic IR fix for a mechanical issue, when one exists: shrink the offending element one size
 * step for overflow-like findings, or switch it to the foreground colour for low contrast. Returns
 * undefined when only a code-level (Pi) fix can help.
 */
export function mechanicalPatch(issue: QaIssue, scene: MotionScene): ScenePatch | undefined {
  const targetId = elementFromSelector(issue.evidence?.selector, scene.id) ?? largestTextElement(scene)?.id;
  const element = scene.elements.find((e) => e.id === targetId);
  if (!element || element.kind === "shape" || element.kind === "image") return undefined;
  if (SHRINK_CATEGORIES.has(issue.category)) {
    const current = element.style.size ?? (element.role === "hero" ? "display" : "title");
    const next = SIZES[SIZES.indexOf(current) + 1];
    if (!next) return undefined;
    return {
      sceneId: scene.id,
      source: "jev",
      rationale: `mechanical fix for ${issue.category}`,
      changes: [
        {
          type: "typography",
          target: element.id,
          instruction: `Reduce ${element.id} from ${current} to ${next} to fix ${issue.category}`,
          params: { size: next },
        },
      ],
    };
  }
  if (issue.category === "low_contrast" && element.style.color !== "foreground") {
    return {
      sceneId: scene.id,
      source: "jev",
      rationale: "mechanical fix for low_contrast",
      changes: [
        {
          type: "color",
          target: element.id,
          instruction: `Use the foreground colour for ${element.id} to restore contrast`,
          params: { color: "foreground" },
        },
      ],
    };
  }
  return undefined;
}
