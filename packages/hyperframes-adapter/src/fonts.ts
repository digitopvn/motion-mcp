import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FontRole, MotionIR } from "@motion-mcp/motion-ir";
import { cmp } from "./util.ts";

/**
 * Font strategy (deterministic, offline).
 *
 * HyperFrames' producer injects `@font-face` rules at render time for any family that
 * has none: bundled base64 data for a small alias set (Inter, JetBrains Mono, ...),
 * otherwise a Google Fonts download (network) or a capture of a locally installed
 * system font. The last two differ between machines and fail offline, and
 * `hyperframes-localize-fonts` only rewrites remote font URLs that already exist in the HTML.
 *
 * The compiler therefore ships the fonts inside the project: the brand family is resolved
 * to an `@fontsource/<slug>` package pinned in this package's dependencies, its latin,
 * latin-ext and vietnamese woff2 subsets are copied into `assets/fonts/`, and every
 * composition file declares matching `@font-face` rules with `font-display: block`. The
 * producer sees existing faces and skips injection, so no network is touched and the
 * output is identical on every machine. Families without a pinned package fall back to a
 * bundled family per role (reported as a compile warning), never to a system font.
 */

const require = createRequire(import.meta.url);

const SUBSETS = ["latin", "latin-ext", "vietnamese"] as const;

const ROLE_FALLBACK: Record<FontRole, string> = {
  display: "Inter",
  body: "Inter",
  mono: "JetBrains Mono",
};

const GENERIC: Record<string, string> = {
  serif: "serif",
  "sans-serif": "sans-serif",
  monospace: "monospace",
  display: "sans-serif",
  handwriting: "cursive",
};

interface FontsourceMetadata {
  id: string;
  family: string;
  subsets: string[];
  weights: number[];
  styles: string[];
  category?: string;
}

interface FontPackage {
  dir: string;
  meta: FontsourceMetadata;
  unicode: Record<string, string>;
}

export interface FontUsage {
  weights: Set<number>;
  italic: boolean;
}

export interface FontFace {
  weight: number;
  style: "normal" | "italic";
  unicodeRange: string;
  /** Absolute source path of the woff2 file. */
  source: string;
  /** Project-relative destination (`assets/fonts/...`). */
  dest: string;
}

export interface ResolvedFont {
  role: FontRole;
  requested: string;
  family: string;
  substituted: boolean;
  /** CSS font-family value (quoted family + generic fallback). */
  stack: string;
  faces: FontFace[];
}

export interface FontPlan {
  fonts: Record<FontRole, ResolvedFont>;
  warnings: string[];
  /** De-duplicated `{source, dest}` copies, sorted by dest. */
  files: { source: string; dest: string }[];
  /** `@font-face` CSS shared by every composition file. */
  css: string;
}

export const fontSlug = (family: string): string =>
  family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const packageCache = new Map<string, FontPackage | null>();

function loadFontPackage(family: string): FontPackage | null {
  const slug = fontSlug(family);
  if (!slug) return null;
  const cached = packageCache.get(slug);
  if (cached !== undefined) return cached;
  let pkg: FontPackage | null = null;
  try {
    const metaPath = require.resolve(`@fontsource/${slug}/metadata.json`);
    const dir = dirname(metaPath);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as FontsourceMetadata;
    const unicode = JSON.parse(readFileSync(join(dir, "unicode.json"), "utf8")) as Record<string, string>;
    pkg = { dir, meta, unicode };
  } catch {
    pkg = null;
  }
  packageCache.set(slug, pkg);
  return pkg;
}

/** Nearest available weight; ties resolve to the heavier face. */
export function nearestWeight(available: number[], wanted: number): number {
  let best = available[0] ?? 400;
  for (const w of available) {
    const d = Math.abs(w - wanted);
    const bd = Math.abs(best - wanted);
    if (d < bd || (d === bd && w > best)) best = w;
  }
  return best;
}

function resolveRole(role: FontRole, requested: string, usage: FontUsage, warnings: string[]): ResolvedFont {
  let pkg = loadFontPackage(requested);
  let substituted = false;
  if (!pkg) {
    const fallback = ROLE_FALLBACK[role];
    pkg = loadFontPackage(fallback);
    substituted = true;
    warnings.push(
      `font "${requested}" (${role}) has no bundled files; substituted "${fallback}" for deterministic offline rendering`,
    );
    if (!pkg) throw new Error(`bundled fallback font @fontsource/${fontSlug(fallback)} is not installed`);
  }
  const { meta, unicode, dir } = pkg;
  const generic = GENERIC[meta.category ?? ""] ?? (role === "mono" ? "monospace" : "sans-serif");
  const weights = [...(usage.weights.size > 0 ? usage.weights : new Set([400]))].sort((a, b) => a - b);
  const styles: ("normal" | "italic")[] = ["normal"];
  if (usage.italic && meta.styles.includes("italic")) styles.push("italic");
  const subsets = SUBSETS.filter((s) => meta.subsets.includes(s));
  const faces: FontFace[] = [];
  for (const style of styles) {
    for (const weight of weights) {
      // Declare the face at the requested weight but point it at the nearest real file,
      // so the browser never synthesizes a fake bold.
      const fileWeight = nearestWeight(meta.weights, weight);
      for (const subset of subsets) {
        const file = `${meta.id}-${subset}-${fileWeight}-${style}.woff2`;
        faces.push({
          weight,
          style,
          unicodeRange: unicode[subset] ?? "",
          source: join(dir, "files", file),
          dest: `assets/fonts/${file}`,
        });
      }
    }
  }
  return {
    role,
    requested,
    family: meta.family,
    substituted,
    stack: `"${meta.family}", ${generic}`,
    faces,
  };
}

function faceCss(font: ResolvedFont): string[] {
  return font.faces.map((f) =>
    [
      "@font-face {",
      `  font-family: "${font.family}";`,
      `  src: url("${f.dest}") format("woff2");`,
      `  font-weight: ${f.weight};`,
      `  font-style: ${f.style};`,
      "  font-display: block;",
      ...(f.unicodeRange ? [`  unicode-range: ${f.unicodeRange};`] : []),
      "}",
    ].join("\n"),
  );
}

/** Resolve brand fonts to bundled files for the weights/styles the compiled scenes use. */
export function planFonts(fonts: MotionIR["brand"]["fonts"], usage: Record<FontRole, FontUsage>): FontPlan {
  const warnings: string[] = [];
  const resolved: Record<FontRole, ResolvedFont> = {
    display: resolveRole("display", fonts.display, usage.display, warnings),
    body: resolveRole("body", fonts.body, usage.body, warnings),
    mono: resolveRole("mono", fonts.mono, usage.mono, warnings),
  };
  // Roles may share a family (display = body): merge faces so each rule is emitted once.
  const byFamily = new Map<string, ResolvedFont>();
  for (const font of Object.values(resolved)) {
    const existing = byFamily.get(font.family);
    if (!existing) {
      byFamily.set(font.family, { ...font, faces: [...font.faces] });
      continue;
    }
    for (const face of font.faces) {
      if (
        !existing.faces.some(
          (f) => f.weight === face.weight && f.style === face.style && f.dest === face.dest,
        )
      ) {
        existing.faces.push(face);
      }
    }
  }
  const families = [...byFamily.values()].sort((a, b) => cmp(a.family, b.family));
  for (const f of families) {
    f.faces.sort((a, b) => cmp(a.style, b.style) || a.weight - b.weight || cmp(a.dest, b.dest));
  }
  const files = new Map<string, string>();
  for (const f of families) for (const face of f.faces) files.set(face.dest, face.source);
  return {
    fonts: resolved,
    warnings,
    files: [...files.entries()].sort(([a], [b]) => cmp(a, b)).map(([dest, source]) => ({ dest, source })),
    css: families.flatMap(faceCss).join("\n"),
  };
}
