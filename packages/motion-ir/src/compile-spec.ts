import type { AspectPreset, CreativeSpec } from "./creative-spec.ts";
import {
  type Beat,
  MOTION_IR_VERSION,
  MotionIR,
  type MotionPrimitive,
  type MotionScene,
  type SceneElement,
  round3,
  totalDuration,
} from "./motion-ir.ts";
import type { EasingToken, Tempo } from "./tokens.ts";

const ASPECT_SIZES: Record<AspectPreset, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

interface TempoProfile {
  entrance: number;
  gap: number;
  lead: number;
}

const TEMPO: Record<Tempo, TempoProfile> = {
  still: { entrance: 1.0, gap: 0.45, lead: 0.4 },
  restrained: { entrance: 0.8, gap: 0.35, lead: 0.3 },
  measured: { entrance: 0.65, gap: 0.25, lead: 0.25 },
  lively: { entrance: 0.5, gap: 0.16, lead: 0.2 },
  energetic: { entrance: 0.4, gap: 0.1, lead: 0.12 },
};

const ROLE_ORDER: Record<SceneElement["role"], number> = {
  background: 0,
  hero: 1,
  secondary: 2,
  tertiary: 3,
  annotation: 4,
};

function primitiveFor(el: SceneElement, tempo: Tempo): MotionPrimitive {
  const calm = tempo === "still" || tempo === "restrained";
  switch (el.kind) {
    case "metric":
      return "count-up";
    case "code":
      return "type-on";
    case "list":
      return "stagger-in";
    case "shape":
      return el.shape === "rule" || el.shape === "arrow" || el.shape === "bracket" ? "draw" : "fade-in";
    case "image":
      return calm ? "fade-in" : "scale-in";
    case "logo":
      return "fade-in";
    case "text":
      if (el.role === "hero") return calm ? "mask-reveal" : "fade-up";
      return el.role === "annotation" ? "fade-in" : "fade-up";
  }
}

function pickEasing(preferred: EasingToken[], avoid: EasingToken[]): EasingToken {
  return preferred.find((e) => !avoid.includes(e)) ?? (avoid.includes("decelerate") ? "standard" : "decelerate");
}

/**
 * Derive choreography when the director left it out. Hero first, then supporting elements
 * in hierarchy order, finished early enough to respect the hold ratio.
 */
export function autoChoreograph(
  scene: Pick<MotionScene, "elements" | "duration">,
  opts: { tempo: Tempo; holdRatio: number; easing: EasingToken; maxSimultaneous: number },
): Beat[] {
  const profile = TEMPO[opts.tempo];
  const ordered = [...scene.elements].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const budget = Math.max(0.4, scene.duration * (1 - opts.holdRatio) - profile.lead);
  const n = ordered.length;
  let entrance = profile.entrance;
  let gap = profile.gap;
  // Compress when the natural sequence would eat into the hold.
  const natural = entrance + (n - 1) * (gap + entrance * 0.5);
  if (natural > budget) {
    const k = budget / natural;
    entrance = Math.max(0.2, entrance * k);
    gap = Math.max(0.04, gap * k);
  }
  const beats: Beat[] = [];
  let t = profile.lead;
  for (const [i, el] of ordered.entries()) {
    const primitive = primitiveFor(el, opts.tempo);
    const duration = el.kind === "code" || el.kind === "metric" ? Math.max(entrance, 0.9) : entrance;
    beats.push({
      target: el.id,
      primitive,
      at: round3(t),
      duration: round3(Math.min(duration, Math.max(0.2, scene.duration - t - 0.1))),
      easing: el.kind === "metric" ? "decelerate" : opts.easing,
      direction: primitive === "slide-in" ? "left" : undefined,
      stagger: primitive === "stagger-in" ? 0.08 : undefined,
    });
    // Elements past the simultaneity limit wait for the previous one to mostly settle.
    const overlap = i + 1 >= opts.maxSimultaneous ? entrance : entrance * 0.5;
    t += gap + overlap;
  }
  return beats;
}

/** Deterministic compile: CreativeSpec (director output) → Motion IR. */
export function compileCreativeSpec(spec: CreativeSpec, opts: { id: string; duration?: number }): MotionIR {
  const taste = spec.tastePacket;
  const aspect = spec.format?.aspect ?? "16:9";
  const size = ASPECT_SIZES[aspect];
  const easing = pickEasing(taste.motionLanguage.easing, taste.motionLanguage.avoidEasing);
  const holdRatio = taste.motionLanguage.holdRatio;
  const maxSimultaneous = taste.visualDensity <= 2 ? 2 : taste.visualDensity >= 4 ? 4 : 3;

  let scenes = spec.scenes.map((s, index) => {
    const next = spec.scenes[index + 1];
    const scene: MotionScene = {
      id: s.id,
      role: s.role,
      intent: s.intent,
      duration: s.duration,
      focalPoint: s.focalPoint,
      layout: {
        template: s.layout ?? (s.role === "cta" || s.role === "hook" ? "statement" : "center"),
        align: "center",
        background: "background",
        safeArea: 0.08,
      },
      elements: s.elements,
      choreography: [],
      transitionIn: { kind: index === 0 ? "fade" : "cut", duration: index === 0 ? 0.4 : 0 },
      transitionOut: {
        kind: s.transitionOut ?? (next ? "cut" : "fade"),
        duration: (s.transitionOut ?? (next ? "cut" : "fade")) === "cut" ? 0 : 0.4,
      },
      assetNeeds: s.assetNeeds ?? [],
      constraints: [],
      antiPatterns: s.antiPatterns ?? [],
      acceptance: s.acceptance ?? [],
      implementation: s.implementation ?? "deterministic",
      implementationNotes: s.implementationNotes,
    };
    scene.choreography =
      s.choreography && s.choreography.length > 0
        ? s.choreography
        : autoChoreograph(scene, { tempo: taste.motionLanguage.tempo, holdRatio, easing, maxSimultaneous });
    return scene;
  });

  // Fit to a requested total duration by scaling scene durations proportionally.
  if (opts.duration && Math.abs(totalDuration({ scenes }) - opts.duration) > 0.05) {
    const k = opts.duration / totalDuration({ scenes });
    scenes = scenes.map((s) => ({
      ...s,
      duration: round3(s.duration * k),
      choreography: s.choreography.map((b) => ({
        ...b,
        at: typeof b.at === "number" ? round3(b.at * k) : b.at,
        duration: round3(Math.max(0.05, b.duration * Math.min(1, k))),
      })),
    }));
  }

  const brandColors = spec.brand?.colors ?? {
    background: taste.color.background,
    foreground: taste.color.foreground,
    accent: taste.color.accent,
    muted: taste.color.muted,
    surface: taste.color.surface,
  };

  return MotionIR.parse({
    version: MOTION_IR_VERSION,
    id: opts.id,
    title: spec.title,
    format: {
      ...size,
      fps: spec.format?.fps ?? 30,
      duration: totalDuration({ scenes }),
      aspectRatio: aspect,
    },
    creative: {
      concept: taste.creativeIntent.concept,
      mood: taste.mood,
      energy: taste.energy,
      visualDensity: taste.visualDensity,
      emotionalArc: taste.emotionalArc,
    },
    brand: {
      name: spec.brand?.name,
      colors: brandColors,
      fonts: spec.brand?.fonts ?? {
        display: taste.typography.display,
        body: taste.typography.body,
        mono: taste.typography.mono ?? "JetBrains Mono",
      },
      radius: spec.brand?.radius ?? "subtle",
      visualRules: spec.brand?.visualRules ?? taste.visualLanguage,
    },
    motionLanguage: {
      tempo: taste.motionLanguage.tempo,
      preferredEasing: taste.motionLanguage.easing,
      avoidEasing: taste.motionLanguage.avoidEasing,
      cameraMotion: taste.motionLanguage.camera,
      maxSimultaneousObjects: maxSimultaneous,
      holdRatio,
      principles: taste.motionLanguage.principles,
      avoid: taste.avoid,
    },
    audio: taste.audio
      ? {
          musicDirection: taste.audio.music,
          voiceDirection: taste.audio.voice,
          sfxDirection: taste.audio.sfx,
          syncStrategy: "scene-cuts",
        }
      : undefined,
    styleRefs: spec.styleRefs ?? [],
    scenes,
  });
}
