import type { MotionIR, MotionScene, SceneElement, Transition } from "@motion-mcp/motion-ir";
import { elementDomId, type SceneContext } from "./elements.ts";
import type { ResolvedBeat } from "./timing.ts";
import { gsapEase } from "./tokens.ts";
import { num, scriptJson } from "./util.ts";

type Vars = Record<string, string | number | boolean>;
type TransitionKind = Transition["kind"];

/**
 * Emits GSAP timeline statements for one scene. Rules enforced here:
 * - every tween is a `fromTo` at an absolute scene-local position (seek-safe);
 * - the first tween on a target keeps GSAP's default `immediateRender` so the element is
 *   hidden before its entrance; later tweens on the same target use `immediateRender:false`
 *   so their start state never leaks back to t=0;
 * - only transform/opacity/clip-path/stroke properties are animated (no layout props);
 * - finite motion only: no repeat, no callbacks except the count-up text writer.
 */
export class TimelineWriter {
  readonly lines: string[] = [];
  private readonly started = new Set<string>();
  private usesCounter = false;

  fromTo(target: string, from: Vars, to: Vars, position: number): void {
    const first = !this.started.has(target);
    this.started.add(target);
    const toVars: Vars = { ...to };
    if (!first) toVars.immediateRender = false;
    this.lines.push(
      `tl.fromTo(${scriptJson(target)}, ${scriptJson(from)}, ${scriptJson(toVars)}, ${num(position)});`,
    );
  }

  countUp(
    numberId: string,
    value: number,
    decimals: number,
    duration: number,
    ease: string,
    position: number,
  ): void {
    this.usesCounter = true;
    this.lines.push(
      `countUp(${scriptJson(numberId)}, ${scriptJson(value)}, ${decimals}, ${num(duration)}, ${scriptJson(ease)}, ${num(position)});`,
    );
  }

  /** Helper functions referenced by the statements (declared before them). */
  preamble(): string[] {
    if (!this.usesCounter) return [];
    return [
      "function formatNumber(v, d) {",
      '  var parts = Math.abs(v).toFixed(d).split(".");',
      '  var int = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");',
      '  var neg = v < 0 && Number(parts.join(".")) !== 0;',
      '  return (neg ? "-" : "") + int + (parts[1] ? "." + parts[1] : "");',
      "}",
      "function countUp(id, value, decimals, duration, ease, position) {",
      "  var el = document.getElementById(id);",
      "  var state = { v: 0 };",
      "  tl.fromTo(state, { v: 0 }, { v: value, duration: duration, ease: ease, immediateRender: false,",
      "    onUpdate: function () { el.textContent = formatNumber(state.v, decimals); } }, position);",
      "}",
    ];
  }
}

function offsetFor(direction: "up" | "down" | "left" | "right", distance: number): Vars {
  switch (direction) {
    case "up":
      return { y: distance };
    case "down":
      return { y: -distance };
    case "left":
      return { x: distance };
    case "right":
      return { x: -distance };
  }
}

const zeroOffset = (v: Vars): Vars => Object.fromEntries(Object.keys(v).map((k) => [k, 0]));

/** Primitive → tweens for one beat. Unsupported primitive/element pairs degrade to a fade. */
export function writeBeat(
  w: TimelineWriter,
  ctx: SceneContext,
  el: SceneElement,
  rb: ResolvedBeat,
  format: MotionIR["format"],
): void {
  const { beat, start, duration } = rb;
  const id = elementDomId(ctx, el.id);
  const sel = `#${id}`;
  const ease = gsapEase(beat.easing, ctx.ir.motionLanguage.preferredEasing[0] ?? "decelerate");
  const d = num(duration);
  const travel = Math.round(0.045 * Math.min(format.width, format.height));
  const base = { duration: Number(d), ease };
  const fade = () => w.fromTo(sel, { opacity: 0 }, { opacity: 1, ...base }, start);

  switch (beat.primitive) {
    case "fade-in":
      fade();
      return;
    case "fade-up": {
      // `direction` is the direction of travel (default up: rises from below).
      const off = offsetFor(beat.direction ?? "up", travel);
      w.fromTo(sel, { opacity: 0, ...off }, { opacity: 1, ...zeroOffset(off), ...base }, start);
      return;
    }
    case "slide-in": {
      // `direction` names the side the element enters from (default left).
      const side = beat.direction ?? "left";
      const dist = Math.round(0.08 * (side === "left" || side === "right" ? format.width : format.height));
      const off: Vars =
        side === "left"
          ? { x: -dist }
          : side === "right"
            ? { x: dist }
            : side === "up"
              ? { y: -dist }
              : { y: dist };
      w.fromTo(sel, { opacity: 0, ...off }, { opacity: 1, ...zeroOffset(off), ...base }, start);
      return;
    }
    case "scale-in":
      w.fromTo(sel, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, ...base }, start);
      return;
    case "mask-reveal": {
      // clip-path inset reveal; negative insets keep ascenders/descenders unclipped when settled.
      const dir = beat.direction ?? "up";
      const hidden: Record<typeof dir, string> = {
        up: "inset(100% -8% -25% -8%)",
        down: "inset(-25% -8% 100% -8%)",
        left: "inset(-25% -8% -25% 100%)",
        right: "inset(-25% 100% -25% -8%)",
      };
      const off = offsetFor(dir, Math.round(travel * 0.6));
      w.fromTo(
        sel,
        { clipPath: hidden[dir], ...off },
        { clipPath: "inset(-25% -8% -25% -8%)", ...zeroOffset(off), ...base },
        start,
      );
      return;
    }
    case "type-on": {
      if (el.kind !== "text" && el.kind !== "code" && !(el.kind === "logo" && !el.asset)) {
        fade();
        return;
      }
      const count = [...(el.kind === "code" ? el.code : el.text)].filter((c) => c !== "\n").length;
      if (el.kind === "code") {
        // The code panel appears first, then characters type in.
        w.fromTo(
          sel,
          { opacity: 0 },
          { opacity: 1, duration: Math.min(0.25, duration), ease: "power1.out" },
          start,
        );
      }
      const each = Math.max(0.001, duration / Math.max(1, count));
      w.fromTo(
        `${sel} .ch`,
        { opacity: 0 },
        { opacity: 1, duration: 0.001, ease: "none", stagger: Number(each.toFixed(4)) },
        start,
      );
      return;
    }
    case "draw": {
      if (el.kind === "shape" && (el.shape === "rule" || el.shape === "box")) {
        w.fromTo(sel, { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, ...base }, start);
      } else if (el.kind === "shape" && el.shape !== "dot-grid") {
        w.fromTo(`${sel} .draw-path`, { strokeDashoffset: 1 }, { strokeDashoffset: 0, ...base }, start);
      } else {
        w.fromTo(
          sel,
          { clipPath: "inset(-10% 100% -10% -2%)" },
          { clipPath: "inset(-10% -2% -10% -2%)", ...base },
          start,
        );
      }
      return;
    }
    case "count-up": {
      if (el.kind !== "metric") {
        fade();
        return;
      }
      w.fromTo(
        sel,
        { opacity: 0 },
        { opacity: 1, duration: Math.min(0.3, duration), ease: "power1.out" },
        start,
      );
      w.countUp(`${id}-num`, el.value, el.decimals, duration, ease, start);
      return;
    }
    case "stagger-in": {
      let children: string;
      let n: number;
      if (el.kind === "list") {
        children = `${sel} .item`;
        n = el.items.length;
      } else if (el.kind === "text" || (el.kind === "logo" && !el.asset)) {
        children = `${sel} .w`;
        n = el.text.split(/\s+/).filter(Boolean).length;
      } else {
        fade();
        return;
      }
      const stagger = beat.stagger ?? 0.08;
      // Fit the whole cascade into the beat: each child animates for what remains after the last offset.
      const each = Math.max(0.12, duration - stagger * Math.max(0, n - 1));
      const off = offsetFor(beat.direction ?? "up", Math.round(travel * 0.6));
      w.fromTo(
        children,
        { opacity: 0, ...off },
        { opacity: 1, ...zeroOffset(off), duration: Number(num(each)), ease, stagger },
        start,
      );
      return;
    }
    case "emphasize": {
      const half = Number(num(duration / 2));
      w.fromTo(sel, { scale: 1 }, { scale: 1.06, duration: half, ease: "power2.out" }, start);
      w.fromTo(sel, { scale: 1.06 }, { scale: 1, duration: half, ease: "power2.inOut" }, start + half);
      return;
    }
    case "hold":
      return;
    case "exit": {
      const off = offsetFor(beat.direction ?? "up", Math.round(travel * 0.5));
      w.fromTo(sel, { opacity: 1, ...zeroOffset(off) }, { opacity: 0, ...negate(off), ...base }, start);
      return;
    }
  }
}

const negate = (v: Vars): Vars => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, -(x as number)]));

const CIRCLE_OPEN = "circle(75% at 50% 50%)";
const CIRCLE_SHUT = "circle(0% at 50% 50%)";

/**
 * Scene transitions animate the scene's own stage wrapper in scene-local time: the "in"
 * half at the scene start, the "out" half ending at the scene end. Scenes never overlap,
 * so a fade reads as a dip through the root background. `match-cut` degrades to `cut`.
 */
export function writeTransition(
  w: TimelineWriter,
  stageSel: string,
  phase: "in" | "out",
  kind: TransitionKind,
  duration: number,
  sceneDuration: number,
): void {
  if (kind === "cut" || kind === "match-cut" || duration <= 0) return;
  const pos = phase === "in" ? 0 : Math.max(0, sceneDuration - duration);
  const d = Number(num(duration));
  const easeIn = "power2.out";
  const easeOut = "power2.in";
  const both = "power2.inOut";
  const tw = (from: Vars, to: Vars, ease: string) =>
    w.fromTo(stageSel, from, { ...to, duration: d, ease }, pos);
  switch (kind) {
    case "fade":
      if (phase === "in") tw({ opacity: 0 }, { opacity: 1 }, easeIn);
      else tw({ opacity: 1 }, { opacity: 0 }, easeOut);
      return;
    case "slide-left":
      if (phase === "in") tw({ xPercent: 100 }, { xPercent: 0 }, "power3.out");
      else tw({ xPercent: 0 }, { xPercent: -100 }, "power3.in");
      return;
    case "slide-up":
      if (phase === "in") tw({ yPercent: 100 }, { yPercent: 0 }, "power3.out");
      else tw({ yPercent: 0 }, { yPercent: -100 }, "power3.in");
      return;
    case "wipe":
      if (phase === "in") tw({ clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)" }, both);
      else tw({ clipPath: "inset(0% 0% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 100%)" }, both);
      return;
    case "mask":
      if (phase === "in") tw({ clipPath: CIRCLE_SHUT }, { clipPath: CIRCLE_OPEN }, both);
      else tw({ clipPath: CIRCLE_OPEN }, { clipPath: CIRCLE_SHUT }, both);
      return;
    case "scale-through":
      if (phase === "in") tw({ opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1 }, easeIn);
      else tw({ opacity: 1, scale: 1 }, { opacity: 0, scale: 1.18 }, easeOut);
      return;
  }
}

/**
 * Effective transitions for a scene. An explicit non-cut `transitionIn` wins; otherwise
 * the previous scene's `transitionOut` is mirrored so an exit is answered by a matching
 * entrance (the compiled spec only sets `transitionOut` on inner scenes). Both halves are
 * clamped to leave at least 20% of the scene untouched.
 */
export function effectiveTransitions(
  scenes: MotionScene[],
  index: number,
): { in: Transition; out: Transition } {
  const scene = scenes[index]!;
  const prev = index > 0 ? scenes[index - 1] : undefined;
  let tin: Transition = scene.transitionIn;
  if ((tin.kind === "cut" || tin.duration <= 0) && prev && prev.transitionOut.kind !== "cut") {
    tin = { ...prev.transitionOut };
  }
  let tout: Transition = scene.transitionOut;
  const budget = scene.duration * 0.8;
  const total = (tin.kind === "cut" ? 0 : tin.duration) + (tout.kind === "cut" ? 0 : tout.duration);
  if (total > budget && total > 0) {
    const k = budget / total;
    tin = { ...tin, duration: Number(num(tin.duration * k)) };
    tout = { ...tout, duration: Number(num(tout.duration * k)) };
  }
  return { in: tin, out: tout };
}
