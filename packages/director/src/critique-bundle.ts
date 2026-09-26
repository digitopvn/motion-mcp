import { toResponseJsonSchema } from "@motion-mcp/llm";
import {
  type MotionIR,
  type MotionScene,
  type QaIssue,
  ScenePatch,
  type TastePacket,
  type TransitionKind,
} from "@motion-mcp/motion-ir";
import { MotionError, newId } from "@motion-mcp/shared";
import type { z } from "zod";
import { CRITIC_SYSTEM_PROMPT } from "./prompts.ts";

/** A QA issue plus the router's classification, if any. */
export type QaDiagnosis = QaIssue & { rootCause?: string };

export interface SceneArtifacts {
  /** Contact sheet of this scene only: a file path, `data:image/...` URL or https URL. */
  contactSheet: string;
  /** Last frame of the previous scene (boundary only; the neighbour's IR is never included). */
  prevFrame?: string;
  /** First frame of the next scene (boundary only). */
  nextFrame?: string;
  /** Normalized QA issues for the job; only this scene's issues enter the bundle. */
  qaIssues?: QaDiagnosis[];
}

export type TasteSubset = Pick<
  TastePacket,
  "creativeIntent" | "visualHierarchy" | "motionLanguage" | "typography" | "color" | "avoid"
>;

/** Minimal, scene-isolated input for Stage 3 critique. */
export interface SceneCritiqueBundle {
  globalIntent: {
    concept: string;
    feeling: string;
    emotionalArc?: string;
    sceneIndex: number;
    sceneCount: number;
    transitionIn: z.infer<typeof TransitionKind>;
    transitionOut: z.infer<typeof TransitionKind>;
  };
  tastePacket: TasteSubset;
  tasteConstraints: string[];
  sceneIR: MotionScene;
  prevFrame?: string;
  contactSheet: string;
  nextFrame?: string;
  qaDiagnosis: QaDiagnosis[];
}

const MAX_CONSTRAINTS = 16;
const MAX_ISSUES = 20;

/** Build a critique bundle for one scene. Other scenes' IR never enters the bundle. */
export function buildSceneCritiqueBundle(
  ir: MotionIR,
  sceneId: string,
  artifacts: SceneArtifacts,
  taste: TastePacket,
): SceneCritiqueBundle {
  const index = ir.scenes.findIndex((s) => s.id === sceneId);
  const scene = ir.scenes[index];
  if (!scene) throw new MotionError("NOT_FOUND", `Scene ${sceneId} not found in IR ${ir.id}`);
  if (!artifacts.contactSheet)
    throw new MotionError("VALIDATION", "A contact sheet is required for critique");

  const constraints = [...taste.avoid, ...taste.motionLanguage.principles, ...ir.brand.visualRules];
  const bundle: SceneCritiqueBundle = {
    globalIntent: {
      concept: taste.creativeIntent.concept,
      feeling: taste.creativeIntent.feeling,
      emotionalArc: taste.emotionalArc,
      sceneIndex: index,
      sceneCount: ir.scenes.length,
      transitionIn: scene.transitionIn.kind,
      transitionOut: scene.transitionOut.kind,
    },
    tastePacket: {
      creativeIntent: taste.creativeIntent,
      visualHierarchy: taste.visualHierarchy,
      motionLanguage: taste.motionLanguage,
      typography: taste.typography,
      color: taste.color,
      avoid: taste.avoid,
    },
    tasteConstraints: [...new Set(constraints)].slice(0, MAX_CONSTRAINTS),
    sceneIR: structuredClone(scene),
    contactSheet: artifacts.contactSheet,
    qaDiagnosis: (artifacts.qaIssues ?? []).filter((i) => i.sceneId === sceneId).slice(0, MAX_ISSUES),
  };
  if (artifacts.prevFrame) bundle.prevFrame = artifacts.prevFrame;
  if (artifacts.nextFrame) bundle.nextFrame = artifacts.nextFrame;
  return structuredClone(bundle);
}

/** Response schema for one bundle: a ScenePatch whose targets are elements of this scene. */
export function scenePatchSchemaFor(bundle: SceneCritiqueBundle) {
  const elementIds = new Set(bundle.sceneIR.elements.map((e) => e.id));
  return ScenePatch.superRefine((patch, ctx) => {
    for (const [i, change] of patch.changes.entries()) {
      if (change.target !== undefined && change.target !== "scene" && !elementIds.has(change.target)) {
        ctx.addIssue({
          code: "custom",
          message: `target "${change.target}" is not an element of scene ${bundle.sceneIR.id}; use one of ${[...elementIds].join(", ")}`,
          path: ["changes", i, "target"],
        });
      }
    }
  });
}

export interface HostCritiqueRequest {
  kind: "scene_critique";
  requestId: string;
  sceneId: string;
  instructions: string;
  bundle: SceneCritiqueBundle;
  responseSchema: Record<string, unknown>;
  respondWith: string;
}

/**
 * Host-mode Stage 3: package the bundle so the host's own model authors the ScenePatch.
 * No internal model call is made. Frame references are passed through as given.
 */
export function buildHostCritiqueRequest(
  bundle: SceneCritiqueBundle,
  options: { requestId?: string } = {},
): HostCritiqueRequest {
  return {
    kind: "scene_critique",
    requestId: options.requestId ?? newId("crq"),
    sceneId: bundle.sceneIR.id,
    instructions: CRITIC_SYSTEM_PROMPT,
    bundle: structuredClone(bundle),
    responseSchema: toResponseJsonSchema(ScenePatch),
    respondWith: `Call motion_edit with critiqueRequestId and scenePatches: [ScenePatch] for scene "${bundle.sceneIR.id}" only.`,
  };
}
