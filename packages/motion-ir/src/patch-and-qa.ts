import { z } from "zod";
import { EasingToken, SizeToken, ColorToken, WeightToken } from "./tokens.ts";
import { LayoutTemplate, MotionPrimitive, TransitionKind } from "./motion-ir.ts";

export const PatchChangeType = z.enum([
  "timing",
  "motion",
  "layout",
  "typography",
  "color",
  "content",
  "asset",
  "transition",
  "duration",
]);
export type PatchChangeType = z.infer<typeof PatchChangeType>;

/**
 * One change in a scene patch. `instruction` is always present (human/model readable).
 * `params` makes the change deterministically applicable; changes without params are
 * handed to a Pi worker as instructions.
 */
export const PatchChange = z.object({
  type: PatchChangeType,
  instruction: z.string().min(1).max(300),
  target: z.string().max(64).optional(),
  params: z
    .object({
      delaySeconds: z.number().min(-5).max(10).optional(),
      durationSeconds: z.number().min(0.05).max(60).optional(),
      primitive: MotionPrimitive.optional(),
      easing: EasingToken.optional(),
      size: SizeToken.optional(),
      weight: WeightToken.optional(),
      color: ColorToken.optional(),
      text: z.string().max(280).optional(),
      layout: LayoutTemplate.optional(),
      transition: TransitionKind.optional(),
      remove: z.boolean().optional(),
    })
    .optional(),
});
export type PatchChange = z.infer<typeof PatchChange>;

export const ScenePatch = z.object({
  sceneId: z.string().min(1).max(64),
  changes: z.array(PatchChange).min(1).max(12),
  rationale: z.string().max(300).optional(),
  source: z.enum(["opus", "host", "jev", "worker", "user"]).default("worker"),
});
export type ScenePatch = z.infer<typeof ScenePatch>;

export const QaCategory = z.enum([
  "text_clipping",
  "empty_frame",
  "broken_image",
  "low_contrast",
  "misalignment",
  "overflow",
  "unreadable_text",
  "collision",
  "timing_mismatch",
  "safe_area",
  "asset_resolution",
  "runtime_error",
  "lint_error",
  "render_failure",
  "creative",
]);
export type QaCategory = z.infer<typeof QaCategory>;

export const QaIssue = z.object({
  id: z.string(),
  sceneId: z.string().optional(),
  category: QaCategory,
  severity: z.enum(["info", "warn", "error"]),
  message: z.string().max(600),
  source: z.enum(["lint", "check", "vision", "timeline", "render", "critique"]),
  evidence: z
    .object({
      time: z.number().optional(),
      selector: z.string().optional(),
      frame: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});
export type QaIssue = z.infer<typeof QaIssue>;

/** Categories that cheap workers fix mechanically; anything else may need creative judgment. */
export const MECHANICAL_CATEGORIES: ReadonlySet<QaCategory> = new Set([
  "text_clipping",
  "empty_frame",
  "broken_image",
  "low_contrast",
  "misalignment",
  "overflow",
  "unreadable_text",
  "collision",
  "timing_mismatch",
  "safe_area",
  "asset_resolution",
  "runtime_error",
  "lint_error",
  "render_failure",
]);
