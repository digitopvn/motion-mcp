import { AspectPreset, SceneRole } from "@motion-mcp/motion-ir";
import { z } from "zod";

/** Normalized knowledge files authored for the pack. Order is the tie-break order in retrieval. */
export const KNOWLEDGE_FILES = [
  "principles",
  "quality-rubric",
  "shot-patterns",
  "typography",
  "transition-patterns",
  "visual-antipatterns",
  "pacing-patterns",
  "audio-mix",
] as const;
export const KnowledgeKind = z.enum(KNOWLEDGE_FILES);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;

export const PackRole = z.enum(["director", "worker", "both"]);
export type PackRole = z.infer<typeof PackRole>;

export const PipelineStep = z.enum(["direction", "compose", "animate", "audio", "validate", "render", "any"]);
export type PipelineStep = z.infer<typeof PipelineStep>;

export const Energy = z.number().int().min(1).max(5);

const EntryId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/** Empty tag lists mean the entry applies to every value of that facet. */
export const EntryTags = z.strictObject({
  role: PackRole,
  scene_types: z.array(SceneRole),
  styles: z.array(EntryId),
  format: z.array(AspectPreset),
  energy: z.array(Energy),
  pipeline_step: PipelineStep,
  invariant: z.boolean(),
});
export type EntryTags = z.infer<typeof EntryTags>;

export const KnowledgeEntry = z.strictObject({
  id: EntryId,
  text: z.string().min(1).max(240),
  tags: EntryTags,
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

export const KnowledgeFile = z.strictObject({
  kind: KnowledgeKind,
  entries: z.array(KnowledgeEntry).min(1),
});
export type KnowledgeFile = z.infer<typeof KnowledgeFile>;

/** One row of the vendored `styles/index.yaml`. Extra upstream keys are tolerated. */
export const StyleIndexEntry = z.looseObject({
  id: EntryId,
  name: z.string().min(1),
  family: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  energy: Energy,
  best_for: z.array(z.string()).default([]),
  depth: z.string().optional(),
  summary: z.string().min(1),
});
export type StyleIndexEntry = z.infer<typeof StyleIndexEntry>;

export const StyleIndexFile = z.looseObject({ styles: z.array(StyleIndexEntry).min(1) });

/** A vendored profile. Only the keys the pack relies on are checked; the rest passes through untouched. */
export const StyleProfile = z.looseObject({
  id: EntryId,
  name: z.string().min(1),
  family: z.string().min(1),
  summary: z.string().min(1),
  energy: Energy,
  dimensions: z.record(z.string(), z.unknown()),
  scene_types: z
    .looseObject({ prefer: z.array(z.string()).default([]), avoid: z.array(z.string()).default([]) })
    .optional(),
  constraints: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
});
export type StyleProfile = z.infer<typeof StyleProfile>;

export const OverridesFile = z.strictObject({
  styles: z.record(EntryId, z.strictObject({ brand_inspired: z.boolean().optional() })).default({}),
});
export type OverridesFile = z.infer<typeof OverridesFile>;
