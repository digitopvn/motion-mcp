import { z } from "zod";
import {
  AssetNeed,
  Beat,
  Brand,
  LayoutTemplate,
  SceneElement,
  SceneRole,
  TransitionKind,
} from "./motion-ir.ts";
import { EasingToken, HexColor, Tempo } from "./tokens.ts";

/**
 * Taste Packet: the concise, reusable creative direction produced once by the director
 * (host Opus or internal Opus). It is persisted separately from implementation and reused
 * across scenes and revisions so the full conversation never has to be resent.
 */
export const TastePacket = z.object({
  creativeIntent: z.object({
    feeling: z.string().min(1).max(200),
    concept: z.string().min(1).max(400),
  }),
  mood: z.array(z.string().max(40)).max(6).default([]),
  energy: z.number().int().min(1).max(5).default(3),
  visualDensity: z.number().int().min(1).max(5).default(2),
  visualLanguage: z.array(z.string().max(80)).min(1).max(8),
  avoid: z.array(z.string().max(120)).max(12).default([]),
  visualHierarchy: z.object({
    hero: z.string().max(80),
    secondary: z.string().max(80).optional(),
    tertiary: z.string().max(80).optional(),
  }),
  motionLanguage: z.object({
    tempo: Tempo,
    camera: z.enum(["none", "rare", "subtle", "active"]).default("rare"),
    transitions: z.string().max(160).default("motivated cuts"),
    holdRatio: z.number().min(0).max(0.9).default(0.45),
    easing: z.array(EasingToken).max(4).default(["decelerate"]),
    avoidEasing: z.array(EasingToken).max(4).default([]),
    principles: z.array(z.string().max(160)).max(6).default([]),
  }),
  typography: z.object({
    display: z.string().max(80),
    body: z.string().max(80),
    mono: z.string().max(80).optional(),
    direction: z.string().max(200).optional(),
  }),
  color: z.object({
    background: HexColor,
    foreground: HexColor,
    accent: HexColor,
    muted: HexColor.optional(),
    surface: HexColor.optional(),
    direction: z.string().max(200).optional(),
  }),
  audio: z
    .object({
      music: z.string().max(200).optional(),
      voice: z.string().max(200).optional(),
      sfx: z.string().max(200).optional(),
    })
    .optional(),
  emotionalArc: z.string().max(240).optional(),
  sceneRhythm: z.string().max(240).optional(),
});
export type TastePacket = z.infer<typeof TastePacket>;

/** Scene architecture entry as authored by the director. Choreography is optional: the compiler derives it. */
export const SceneSpec = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  role: SceneRole,
  intent: z.string().min(1).max(300),
  duration: z.number().min(0.5).max(60),
  focalPoint: z.string().max(160),
  layout: LayoutTemplate.optional(),
  elements: z.array(SceneElement).min(1).max(12),
  choreography: z.array(Beat).max(40).optional(),
  transitionOut: TransitionKind.optional(),
  assetNeeds: z.array(AssetNeed).max(8).optional(),
  antiPatterns: z.array(z.string().max(200)).max(8).optional(),
  acceptance: z.array(z.string().max(200)).max(8).optional(),
  implementation: z.enum(["deterministic", "custom"]).optional(),
  implementationNotes: z.string().max(600).optional(),
});
export type SceneSpec = z.infer<typeof SceneSpec>;

export const AspectPreset = z.enum(["16:9", "9:16", "1:1", "4:5"]);
export type AspectPreset = z.infer<typeof AspectPreset>;

/**
 * Creative Spec: the full output of director stages 1+2. In `host-opus` mode the MCP client
 * authors this object itself and passes it to `motion_create`, so no internal Opus call is made.
 */
export const CreativeSpec = z.object({
  version: z.literal("0.1").default("0.1"),
  title: z.string().max(120).optional(),
  format: z
    .object({
      aspect: AspectPreset.default("16:9"),
      fps: z.number().int().min(12).max(60).default(30),
    })
    .optional(),
  brand: Brand.partial().optional(),
  styleRefs: z.array(z.string().max(64)).max(4).optional(),
  tastePacket: TastePacket,
  scenes: z.array(SceneSpec).min(1).max(24),
});
export type CreativeSpec = z.infer<typeof CreativeSpec>;
export type CreativeSpecInput = z.input<typeof CreativeSpec>;
