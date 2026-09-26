import { z } from "zod";
import { ColorToken, EasingToken, FontRole, HexColor, SizeToken, Tempo, WeightToken } from "./tokens.ts";

export const MOTION_IR_VERSION = "0.1" as const;

const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase kebab-case");

export const Format = z.object({
  width: z.number().int().min(160).max(7680),
  height: z.number().int().min(160).max(7680),
  fps: z.number().int().min(12).max(120).default(30),
  duration: z.number().positive().max(600).optional(),
  aspectRatio: z.string().optional(),
});
export type Format = z.infer<typeof Format>;

export const Creative = z.object({
  concept: z.string().min(1).max(600),
  mood: z.array(z.string().max(60)).max(8).default([]),
  tone: z.array(z.string().max(60)).max(8).optional(),
  energy: z.number().int().min(1).max(5).default(3),
  visualDensity: z.number().int().min(1).max(5).default(2),
  emotionalArc: z.string().max(300).optional(),
});
export type Creative = z.infer<typeof Creative>;

export const BrandColors = z.object({
  background: HexColor,
  surface: HexColor.optional(),
  foreground: HexColor,
  muted: HexColor.optional(),
  accent: HexColor,
  "accent-2": HexColor.optional(),
  line: HexColor.optional(),
});
export type BrandColors = z.infer<typeof BrandColors>;

export const Brand = z.object({
  name: z.string().max(80).optional(),
  colors: BrandColors,
  fonts: z.object({
    display: z.string().max(80),
    body: z.string().max(80),
    mono: z.string().max(80).default("JetBrains Mono"),
  }),
  radius: z.enum(["none", "subtle", "soft", "round"]).default("subtle"),
  visualRules: z.array(z.string().max(200)).max(12).default([]),
});
export type Brand = z.infer<typeof Brand>;

export const MotionLanguage = z.object({
  tempo: Tempo,
  preferredEasing: z.array(EasingToken).max(4).default(["decelerate", "standard"]),
  avoidEasing: z.array(EasingToken).max(4).default([]),
  cameraMotion: z.enum(["none", "rare", "subtle", "active"]).default("rare"),
  maxSimultaneousObjects: z.number().int().min(1).max(12).default(3),
  /** Fraction of each scene that should be visually still (held) after entrances settle. */
  holdRatio: z.number().min(0).max(0.9).default(0.45),
  principles: z.array(z.string().max(200)).max(10).default([]),
  avoid: z.array(z.string().max(200)).max(12).default([]),
});
export type MotionLanguage = z.infer<typeof MotionLanguage>;

export const AudioDirection = z.object({
  musicDirection: z.string().max(300).optional(),
  voiceDirection: z.string().max(300).optional(),
  sfxDirection: z.string().max(300).optional(),
  syncStrategy: z.enum(["none", "scene-cuts", "beat-grid", "voice-led"]).default("scene-cuts"),
  /** Optional pre-supplied audio asset (storage key or URL). */
  musicAsset: z.string().optional(),
});
export type AudioDirection = z.infer<typeof AudioDirection>;

export const SceneRole = z.enum([
  "hook",
  "title",
  "problem",
  "mechanism",
  "evidence",
  "payoff",
  "cta",
  "transition",
  "custom",
]);
export type SceneRole = z.infer<typeof SceneRole>;

export const ElementRole = z.enum(["hero", "secondary", "tertiary", "annotation", "background"]);
export type ElementRole = z.infer<typeof ElementRole>;

export const ElementStyle = z.object({
  size: SizeToken.optional(),
  weight: WeightToken.optional(),
  color: ColorToken.optional(),
  font: FontRole.optional(),
  italic: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  align: z.enum(["start", "center", "end"]).optional(),
});
export type ElementStyle = z.infer<typeof ElementStyle>;

const ElementBase = z.object({
  id: Id,
  role: ElementRole.default("secondary"),
  style: ElementStyle.default({}),
  region: z.enum(["top", "middle", "bottom", "left", "right", "full"]).optional(),
});

export const TextElement = ElementBase.extend({
  kind: z.literal("text"),
  text: z.string().min(1).max(280),
});
export const MetricElement = ElementBase.extend({
  kind: z.literal("metric"),
  value: z.number(),
  decimals: z.number().int().min(0).max(4).default(0),
  prefix: z.string().max(8).optional(),
  suffix: z.string().max(12).optional(),
  label: z.string().max(80).optional(),
});
export const CodeElement = ElementBase.extend({
  kind: z.literal("code"),
  code: z.string().min(1).max(1200),
  language: z.string().max(24).optional(),
});
export const ListElement = ElementBase.extend({
  kind: z.literal("list"),
  items: z.array(z.string().min(1).max(120)).min(1).max(6),
});
export const ShapeElement = ElementBase.extend({
  kind: z.literal("shape"),
  shape: z.enum(["rule", "box", "circle", "dot-grid", "bracket", "arrow"]),
});
export const ImageElement = ElementBase.extend({
  kind: z.literal("image"),
  /** Asset reference: an `assetNeeds[].id` of the same scene, a storage key, or an https URL. */
  asset: z.string().min(1),
  alt: z.string().max(200).default(""),
  fit: z.enum(["cover", "contain"]).default("contain"),
});
export const LogoElement = ElementBase.extend({
  kind: z.literal("logo"),
  text: z.string().min(1).max(40),
  asset: z.string().optional(),
});

export const SceneElement = z.discriminatedUnion("kind", [
  TextElement,
  MetricElement,
  CodeElement,
  ListElement,
  ShapeElement,
  ImageElement,
  LogoElement,
]);
export type SceneElement = z.infer<typeof SceneElement>;

export const MotionPrimitive = z.enum([
  "fade-in",
  "fade-up",
  "mask-reveal",
  "type-on",
  "scale-in",
  "slide-in",
  "draw",
  "count-up",
  "stagger-in",
  "emphasize",
  "hold",
  "exit",
]);
export type MotionPrimitive = z.infer<typeof MotionPrimitive>;

/** When a beat starts: absolute seconds from scene start, or relative to another beat's target. */
export const BeatTiming = z.union([
  z.number().min(0),
  z.object({ after: Id, offset: z.number().min(-2).max(10).default(0) }),
  z.object({ with: Id, offset: z.number().min(-2).max(10).default(0) }),
]);
export type BeatTiming = z.infer<typeof BeatTiming>;

export const Beat = z.object({
  target: Id,
  primitive: MotionPrimitive,
  at: BeatTiming,
  duration: z.number().min(0.05).max(10).default(0.6),
  easing: EasingToken.optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  stagger: z.number().min(0).max(1).optional(),
});
export type Beat = z.infer<typeof Beat>;

export const TransitionKind = z.enum([
  "cut",
  "fade",
  "slide-left",
  "slide-up",
  "wipe",
  "mask",
  "scale-through",
  "match-cut",
]);
export const Transition = z.object({
  kind: TransitionKind.default("cut"),
  duration: z.number().min(0).max(2).default(0),
});
export type Transition = z.infer<typeof Transition>;

export const AssetNeed = z.object({
  id: Id,
  kind: z.enum(["image", "video", "audio", "icon", "logo", "texture"]),
  description: z.string().max(400),
  source: z.enum(["provided", "generate", "registry", "none"]).default("generate"),
  required: z.boolean().default(false),
  /** Resolved storage key or URL once the asset exists. */
  resolved: z.string().optional(),
});
export type AssetNeed = z.infer<typeof AssetNeed>;

export const LayoutTemplate = z.enum(["center", "split", "stack", "grid", "full-bleed", "lower-third", "statement"]);

export const MotionScene = z.object({
  id: Id,
  role: SceneRole,
  intent: z.string().min(1).max(300),
  purpose: z.string().max(300).optional(),
  narrativeRole: z.string().max(120).optional(),
  duration: z.number().min(0.5).max(60),
  focalPoint: z.string().max(160),
  visualHierarchy: z
    .object({ hero: z.string().max(80), secondary: z.string().max(80).optional(), tertiary: z.string().max(80).optional() })
    .optional(),
  layout: z
    .object({
      template: LayoutTemplate.default("center"),
      align: z.enum(["start", "center", "end"]).default("center"),
      background: ColorToken.default("background"),
      safeArea: z.number().min(0).max(0.2).default(0.08),
    })
    .default({ template: "center", align: "center", background: "background", safeArea: 0.08 }),
  elements: z.array(SceneElement).min(1).max(12),
  choreography: z.array(Beat).max(40).default([]),
  transitionIn: Transition.default({ kind: "cut", duration: 0 }),
  transitionOut: Transition.default({ kind: "cut", duration: 0 }),
  assetNeeds: z.array(AssetNeed).max(8).default([]),
  constraints: z.array(z.string().max(200)).max(8).default([]),
  antiPatterns: z.array(z.string().max(200)).max(8).default([]),
  acceptance: z.array(z.string().max(200)).max(8).default([]),
  /** `custom` scenes are implemented by a Pi worker instead of the deterministic compiler. */
  implementation: z.enum(["deterministic", "custom"]).default("deterministic"),
  implementationNotes: z.string().max(600).optional(),
});
export type MotionScene = z.infer<typeof MotionScene>;

export const MotionIR = z
  .object({
    version: z.literal(MOTION_IR_VERSION),
    id: z.string().min(1).max(64),
    title: z.string().max(120).optional(),
    format: Format,
    creative: Creative,
    brand: Brand,
    motionLanguage: MotionLanguage,
    audio: AudioDirection.optional(),
    /** Domain-pack style profile ids that informed this IR (for retrieval, not rendering). */
    styleRefs: z.array(z.string().max(64)).max(4).default([]),
    scenes: z.array(MotionScene).min(1).max(40),
  })
  .superRefine((ir, ctx) => {
    const sceneIds = new Set<string>();
    for (const [si, scene] of ir.scenes.entries()) {
      if (sceneIds.has(scene.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate scene id ${scene.id}`, path: ["scenes", si, "id"] });
      }
      sceneIds.add(scene.id);
      const elementIds = new Set(scene.elements.map((e) => e.id));
      if (elementIds.size !== scene.elements.length) {
        ctx.addIssue({ code: "custom", message: `duplicate element id in ${scene.id}`, path: ["scenes", si] });
      }
      for (const [bi, beat] of scene.choreography.entries()) {
        const refs = [beat.target];
        if (typeof beat.at === "object") refs.push("after" in beat.at ? beat.at.after : beat.at.with);
        for (const ref of refs) {
          if (ref !== "scene" && !elementIds.has(ref)) {
            ctx.addIssue({
              code: "custom",
              message: `beat references unknown element "${ref}" in scene ${scene.id}`,
              path: ["scenes", si, "choreography", bi],
            });
          }
        }
      }
    }
  });
export type MotionIR = z.infer<typeof MotionIR>;
export type MotionIRInput = z.input<typeof MotionIR>;

export function sceneStartTimes(ir: Pick<MotionIR, "scenes">): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const scene of ir.scenes) {
    starts.push(round3(t));
    t += scene.duration;
  }
  return starts;
}

export function totalDuration(ir: Pick<MotionIR, "scenes">): number {
  return round3(ir.scenes.reduce((sum, s) => sum + s.duration, 0));
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
