import { MotionIR, type MotionScene, round3 } from "./motion-ir.ts";
import type { PatchChange, ScenePatch } from "./patch-and-qa.ts";

export interface ApplyPatchResult {
  ir: MotionIR;
  applied: PatchChange[];
  /** Changes without deterministic params; a worker must implement them from the instruction. */
  deferred: PatchChange[];
}

function applyChange(scene: MotionScene, change: PatchChange): boolean {
  const p = change.params;
  if (!p) return false;
  const target = change.target;
  const beats = target ? scene.choreography.filter((b) => b.target === target) : [];
  const element = target ? scene.elements.find((e) => e.id === target) : undefined;

  switch (change.type) {
    case "timing":
      if (p.delaySeconds === undefined || beats.length === 0) return false;
      for (const b of beats) {
        if (typeof b.at === "number") b.at = round3(Math.max(0, b.at + p.delaySeconds));
        else b.at = { ...b.at, offset: round3(b.at.offset + p.delaySeconds) };
      }
      return true;
    case "motion": {
      if (beats.length === 0) return false;
      let changed = false;
      for (const b of beats) {
        if (p.primitive) {
          b.primitive = p.primitive;
          changed = true;
        }
        if (p.easing) {
          b.easing = p.easing;
          changed = true;
        }
        if (p.durationSeconds) {
          b.duration = p.durationSeconds;
          changed = true;
        }
      }
      return changed;
    }
    case "typography":
    case "color":
      if (!element) return false;
      if (p.size) element.style.size = p.size;
      if (p.weight) element.style.weight = p.weight;
      if (p.color) element.style.color = p.color;
      return Boolean(p.size || p.weight || p.color);
    case "content":
      if (!element) return false;
      if (p.remove) {
        scene.elements = scene.elements.filter((e) => e.id !== element.id);
        scene.choreography = scene.choreography.filter((b) => b.target !== element.id);
        return true;
      }
      if (p.text && (element.kind === "text" || element.kind === "logo")) {
        element.text = p.text;
        return true;
      }
      return false;
    case "layout":
      if (!p.layout) return false;
      scene.layout.template = p.layout;
      return true;
    case "transition":
      if (!p.transition) return false;
      scene.transitionOut = { kind: p.transition, duration: p.transition === "cut" ? 0 : 0.4 };
      return true;
    case "duration":
      if (!p.durationSeconds) return false;
      scene.duration = p.durationSeconds;
      return true;
    case "asset":
      return false;
  }
}

/** Apply a scene patch to a copy of the IR. The result is re-validated. */
export function applyScenePatch(ir: MotionIR, patch: ScenePatch): ApplyPatchResult {
  const copy = structuredClone(ir);
  const scene = copy.scenes.find((s) => s.id === patch.sceneId);
  if (!scene) throw new Error(`scene ${patch.sceneId} not found`);
  const applied: PatchChange[] = [];
  const deferred: PatchChange[] = [];
  for (const change of patch.changes) {
    if (applyChange(scene, change)) applied.push(change);
    else deferred.push(change);
  }
  copy.format.duration = round3(copy.scenes.reduce((s, sc) => s + sc.duration, 0));
  return { ir: MotionIR.parse(copy), applied, deferred };
}
