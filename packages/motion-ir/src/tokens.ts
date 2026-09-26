import { z } from "zod";

/**
 * Renderer-neutral design tokens. Compilers map these to concrete values
 * (for HyperFrames: GSAP eases, px sizes, CSS colors). The IR never contains raw CSS or GSAP names.
 */
export const EasingToken = z.enum([
  "standard",
  "emphasized",
  "decelerate",
  "accelerate",
  "linear",
  "spring-soft",
  "snap",
]);
export type EasingToken = z.infer<typeof EasingToken>;

export const SizeToken = z.enum(["display-xl", "display", "headline", "title", "body", "caption", "label"]);
export type SizeToken = z.infer<typeof SizeToken>;

export const ColorToken = z.enum([
  "background",
  "surface",
  "foreground",
  "muted",
  "accent",
  "accent-2",
  "line",
]);
export type ColorToken = z.infer<typeof ColorToken>;

export const FontRole = z.enum(["display", "body", "mono"]);
export type FontRole = z.infer<typeof FontRole>;

export const WeightToken = z.enum(["light", "regular", "medium", "semibold", "bold", "black"]);
export type WeightToken = z.infer<typeof WeightToken>;

export const Tempo = z.enum(["still", "restrained", "measured", "lively", "energetic"]);
export type Tempo = z.infer<typeof Tempo>;

export const HexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected #rgb or #rrggbb");
