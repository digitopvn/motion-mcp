import type { Beat, MotionScene } from "@motion-mcp/motion-ir";
import { MotionError } from "@motion-mcp/shared";

export interface ResolvedBeat {
  beat: Beat;
  /** Index in `scene.choreography`. */
  index: number;
  /** Absolute scene-local start, seconds. */
  start: number;
  /** Clamped duration, seconds. */
  duration: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Resolve beat timings to absolute scene-local seconds.
 *
 * - number → that time
 * - `{ with: X, offset }` → start of X's first beat + offset
 * - `{ after: X, offset }` → end of X's last beat + offset
 * - the reserved target `scene` refers to the scene start (0)
 *
 * A reference reads in choreography order: it considers the target's beats declared *before*
 * the referencing beat (so `latency count-up → note after latency → latency emphasize after
 * note` is not a cycle). When the target has no earlier beats, all of its other beats are used,
 * which allows forward references. Resolution is iterative; an element without beats counts as
 * present from the scene start. Genuine cycles throw a VALIDATION error. Results are clamped
 * into the scene window.
 */
export function resolveBeats(
  scene: Pick<MotionScene, "id" | "duration" | "choreography" | "elements">,
): ResolvedBeat[] {
  const beats = scene.choreography;
  const starts: (number | undefined)[] = beats.map((b) => (typeof b.at === "number" ? b.at : undefined));
  const elementIds = new Set(scene.elements.map((e) => e.id));

  const window = (target: string, self: number): { first: number; last: number } | "pending" | "none" => {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    let seen = false;
    const hasEarlier = beats.some((b, i) => i < self && b.target === target);
    for (const [i, b] of beats.entries()) {
      if (i === self || b.target !== target || (hasEarlier && i > self)) continue;
      seen = true;
      const s = starts[i];
      if (s === undefined) return "pending";
      first = Math.min(first, s);
      last = Math.max(last, s + b.duration);
    }
    return seen ? { first, last } : "none";
  };

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [i, b] of beats.entries()) {
      if (starts[i] !== undefined || typeof b.at === "number") continue;
      const isAfter = "after" in b.at;
      const ref = isAfter ? (b.at as { after: string }).after : (b.at as { with: string }).with;
      const offset = b.at.offset ?? 0;
      if (ref === "scene" && !elementIds.has("scene")) {
        starts[i] = offset;
        progressed = true;
        continue;
      }
      const w = window(ref, i);
      if (w === "pending") continue;
      if (w === "none") {
        // The referenced element exists but never animates: it is on screen from the scene start.
        starts[i] = offset;
      } else {
        starts[i] = (isAfter ? w.last : w.first) + offset;
      }
      progressed = true;
    }
  }

  const unresolved = beats.map((b, i) => (starts[i] === undefined ? b.target : null)).filter(Boolean);
  if (unresolved.length > 0) {
    throw new MotionError(
      "VALIDATION",
      `circular beat timing in scene ${scene.id}: ${unresolved.join(", ")}`,
      {
        details: { sceneId: scene.id, targets: unresolved },
      },
    );
  }

  const maxStart = Math.max(0, scene.duration - 0.05);
  return beats.map((beat, index) => {
    const start = round3(Math.min(Math.max(0, starts[index] ?? 0), maxStart));
    const duration = round3(Math.max(0.05, Math.min(beat.duration, scene.duration - start)));
    return { beat, index, start, duration };
  });
}
