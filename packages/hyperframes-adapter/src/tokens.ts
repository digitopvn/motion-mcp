import type {
  BrandColors,
  ColorToken,
  EasingToken,
  MotionIR,
  SizeToken,
  WeightToken,
} from "@motion-mcp/motion-ir";

/** Renderer-neutral easing tokens → GSAP ease strings. */
export const GSAP_EASE: Record<EasingToken, string> = {
  decelerate: "power3.out",
  standard: "power2.inOut",
  emphasized: "expo.out",
  accelerate: "power2.in",
  linear: "none",
  "spring-soft": "back.out(1.4)",
  snap: "power4.out",
};

export function gsapEase(token: EasingToken | undefined, fallback: EasingToken = "decelerate"): string {
  return GSAP_EASE[token ?? fallback];
}

/** Type scale in px at a 1080 px reference frame. */
const SIZE_PX_1080: Record<SizeToken, number> = {
  "display-xl": 196,
  display: 140,
  headline: 96,
  title: 64,
  body: 40,
  caption: 30,
  label: 24,
};

/**
 * Size tokens scale with the frame height. The shorter frame edge is used so portrait
 * formats (1080×1920) keep the same type scale as landscape 1080p instead of overflowing
 * their narrow width; for landscape and square formats it is exactly the frame height.
 */
export function frameScale(format: MotionIR["format"]): number {
  return Math.min(format.width, format.height) / 1080;
}

export function sizePx(token: SizeToken, scale: number): number {
  return Math.round(SIZE_PX_1080[token] * scale);
}

/** Line height per size token: tight for display sizes, relaxed for reading sizes. */
export function lineHeight(token: SizeToken): number {
  switch (token) {
    case "display-xl":
    case "display":
      return 1.02;
    case "headline":
      return 1.08;
    case "title":
      return 1.15;
    default:
      return 1.35;
  }
}

/** Negative tracking for large type, neutral for reading sizes (em). */
export function letterSpacing(token: SizeToken): string {
  switch (token) {
    case "display-xl":
    case "display":
      return "-0.025em";
    case "headline":
      return "-0.02em";
    case "title":
      return "-0.01em";
    case "label":
      return "0.06em";
    default:
      return "0";
  }
}

export const WEIGHT_VALUE: Record<WeightToken, number> = {
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  black: 900,
};

export const RADIUS_PX_1080: Record<MotionIR["brand"]["radius"], number> = {
  none: 0,
  subtle: 6,
  soft: 18,
  round: 36,
};

const hexToRgb = (hex: string): [number, number, number] => {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  h = h.slice(0, 6);
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
};

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** Linear sRGB-space mix: `t = 0` → a, `t = 1` → b. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Normalize `#rgb`/`#rrggbbaa` to lowercase `#rrggbb` (alpha dropped: the canvas is opaque). */
export function normalizeHex(hex: string): string {
  return toHex(hexToRgb(hex));
}

/** Resolve every color token to a concrete hex, deriving the optional ones from the palette. */
export function resolvePalette(colors: BrandColors): Record<ColorToken, string> {
  const background = normalizeHex(colors.background);
  const foreground = normalizeHex(colors.foreground);
  const accent = normalizeHex(colors.accent);
  const muted = colors.muted ? normalizeHex(colors.muted) : mixHex(foreground, background, 0.42);
  return {
    background,
    foreground,
    accent,
    muted,
    surface: colors.surface ? normalizeHex(colors.surface) : mixHex(background, foreground, 0.06),
    "accent-2": colors["accent-2"] ? normalizeHex(colors["accent-2"]) : mixHex(accent, foreground, 0.35),
    line: colors.line ? normalizeHex(colors.line) : mixHex(background, foreground, 0.22),
  };
}

export const COLOR_TOKENS: readonly ColorToken[] = [
  "background",
  "surface",
  "foreground",
  "muted",
  "accent",
  "accent-2",
  "line",
];

export const cssColorVar = (token: ColorToken): string => `var(--c-${token})`;
