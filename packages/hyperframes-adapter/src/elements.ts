import type {
  ColorToken,
  FontRole,
  MotionIR,
  MotionPrimitive,
  MotionScene,
  SceneElement,
  SizeToken,
} from "@motion-mcp/motion-ir";
import type { FontUsage } from "./fonts.ts";
import { cssColorVar, letterSpacing, lineHeight, sizePx, WEIGHT_VALUE } from "./tokens.ts";
import { escapeHtml, num } from "./util.ts";

type LayoutTemplateValue = MotionScene["layout"]["template"];

/** Everything an element renderer needs about the scene being compiled. */
export interface SceneContext {
  ir: MotionIR;
  scene: MotionScene;
  /** Id prefix unique per scene (`m-<sceneId>__`). */
  prefix: string;
  scale: number;
  radiusPx: number;
  fontStacks: Record<FontRole, string>;
  fontUsage: Record<FontRole, FontUsage>;
  /** Asset reference → project-relative path or https URL. */
  assets: Record<string, string>;
  /** Primitives used per element id (decides which sub-spans to emit). */
  primitives: Map<string, Set<MotionPrimitive>>;
  warnings: string[];
}

export interface RenderedElement {
  id: string;
  html: string;
  css: string[];
}

export const elementDomId = (ctx: Pick<SceneContext, "prefix">, elementId: string): string =>
  `${ctx.prefix}el-${elementId}`;

interface Typography {
  font: FontRole;
  size: SizeToken;
  weight: number;
  color: ColorToken;
  italic: boolean;
  uppercase: boolean;
  align?: "start" | "center" | "end";
}

function typographyCss(ctx: SceneContext, t: Typography): string[] {
  const usage = ctx.fontUsage[t.font];
  usage.weights.add(t.weight);
  if (t.italic) usage.italic = true;
  const lines = [
    `font-family: ${ctx.fontStacks[t.font]};`,
    `font-size: ${sizePx(t.size, ctx.scale)}px;`,
    `line-height: ${lineHeight(t.size)};`,
    `letter-spacing: ${letterSpacing(t.size)};`,
    `font-weight: ${t.weight};`,
    `color: ${cssColorVar(t.color)};`,
  ];
  if (t.italic) lines.push("font-style: italic;");
  if (t.uppercase) lines.push("text-transform: uppercase;");
  if (t.align)
    lines.push(`text-align: ${t.align === "start" ? "left" : t.align === "end" ? "right" : "center"};`);
  return lines;
}

/**
 * Width (px) of the layout slot an element flows into. Mirrors the layout CSS in compile.ts:
 * the safe-area content box, halved for split columns, divided into cells for grid layouts.
 */
function slotWidthPx(ctx: SceneContext, el: SceneElement): number {
  const { width, height } = ctx.ir.format;
  const { template, safeArea } = ctx.scene.layout;
  const content = width - 2 * Math.round(safeArea * width);
  if (template === "split") return (content - Math.round(0.06 * width)) / 2;
  if (template === "grid" && el.role !== "hero") {
    const cols = Math.min(3, Math.max(1, ctx.scene.elements.length - 1));
    const gap = Math.round(0.035 * Math.min(width, height));
    return (content - gap * (cols - 1)) / cols;
  }
  return content;
}

/** Monospace advance width per em; generous so every bundled mono face fits. */
const MONO_ADVANCE_EM = 0.62;

function rule(selector: string, decls: string[]): string {
  return `${selector} {\n${decls.map((d) => `  ${d}`).join("\n")}\n}`;
}

function defaultTextSize(el: SceneElement, template: LayoutTemplateValue): SizeToken {
  switch (el.role) {
    case "hero":
      return template === "statement" ? "display" : "headline";
    case "secondary":
      return "title";
    case "tertiary":
      return "body";
    case "annotation":
      return "caption";
    case "background":
      return "display-xl";
  }
}

function defaultTextColor(el: SceneElement): ColorToken {
  if (el.role === "annotation" || el.role === "tertiary") return "muted";
  if (el.role === "background") return "line";
  return "foreground";
}

function defaultWeight(el: SceneElement, font: FontRole): number {
  if (el.style.weight) return WEIGHT_VALUE[el.style.weight];
  if (font === "mono") return 400;
  if (el.role === "hero") return font === "display" ? 600 : 700;
  return el.role === "secondary" ? 500 : 400;
}

function typographyFor(
  el: SceneElement,
  template: LayoutTemplateValue,
  defaults: Partial<Typography>,
): Typography {
  const font = el.style.font ?? defaults.font ?? (el.role === "hero" ? "display" : "body");
  return {
    font,
    size: el.style.size ?? defaults.size ?? defaultTextSize(el, template),
    weight: el.style.weight ? WEIGHT_VALUE[el.style.weight] : (defaults.weight ?? defaultWeight(el, font)),
    color: el.style.color ?? defaults.color ?? defaultTextColor(el),
    italic: el.style.italic ?? false,
    uppercase: el.style.uppercase ?? defaults.uppercase ?? false,
    align: el.style.align,
  };
}

/** Split text into word spans (stagger-in) or character spans (type-on); plain otherwise. */
function textSpans(text: string, mode: "words" | "chars" | "plain"): string {
  if (mode === "plain") return escapeHtml(text);
  if (mode === "words") {
    return text
      .split(/(\s+)/)
      .filter((part) => part.length > 0)
      .map((part) => (/^\s+$/.test(part) ? " " : `<span class="w">${escapeHtml(part)}</span>`))
      .join("");
  }
  return [...text].map((ch) => (ch === "\n" ? "\n" : `<span class="ch">${escapeHtml(ch)}</span>`)).join("");
}

function spanMode(ctx: SceneContext, id: string): "words" | "chars" | "plain" {
  const p = ctx.primitives.get(id);
  if (p?.has("type-on")) return "chars";
  if (p?.has("stagger-in")) return "words";
  return "plain";
}

const CODE_KEYWORDS = new Set(
  (
    "const let var function return if else for while do switch case break continue new class extends " +
    "import from export default async await try catch finally throw typeof instanceof in of true false " +
    "null undefined def fn pub struct impl use mod match self this yield lambda interface type enum"
  ).split(" "),
);

/** Minimal, language-agnostic token coloring: comments, strings, numbers, keywords, punctuation. */
export function tokenizeCode(code: string): { cls: string; text: string }[] {
  const tokens: { cls: string; text: string }[] = [];
  const re =
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([^\sA-Za-z_$\d])|(\s+)/g;
  for (const m of code.matchAll(re)) {
    const text = m[0];
    if (m[1]) tokens.push({ cls: "tk-com", text });
    else if (m[2]) tokens.push({ cls: "tk-str", text });
    else if (m[3]) tokens.push({ cls: "tk-num", text });
    else if (m[4]) tokens.push({ cls: CODE_KEYWORDS.has(text) ? "tk-kw" : "tk-id", text });
    else if (m[5]) tokens.push({ cls: "tk-pun", text });
    else tokens.push({ cls: "", text });
  }
  return tokens;
}

function codeHtml(code: string, chars: boolean): string {
  return tokenizeCode(code)
    .map(({ cls, text }) => {
      const inner = chars ? textSpans(text, "chars") : escapeHtml(text);
      return cls ? `<span class="${cls}">${inner}</span>` : inner;
    })
    .join("");
}

/** Fixed-point number formatting with `,` grouping, identical to the runtime formatter. */
export function formatMetric(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [int = "0", frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

function shapeSvg(shape: "circle" | "dot-grid" | "bracket" | "arrow"): string {
  // Colors come from CSS `color` via currentColor: var() is not valid in SVG presentation attributes.
  // Stroke widths are in viewBox units (about 3px at the default element sizes). Strokes are not
  // `vector-effect: non-scaling-stroke`: Chrome then computes dashes in screen space and ignores
  // `pathLength`, so a stroke-dashoffset draw-on would stop part-way.
  const stroke = (width: number) =>
    `stroke="currentColor" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  switch (shape) {
    case "circle":
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><circle class="draw-path" pathLength="1" cx="50" cy="50" r="46" ${stroke(1.2)} /></svg>`;
    case "bracket":
      return `<svg viewBox="0 0 40 130" preserveAspectRatio="xMidYMid meet"><path class="draw-path" pathLength="1" d="M36 4 H6 V126 H36" ${stroke(1.5)} /></svg>`;
    case "arrow":
      return `<svg viewBox="0 0 200 40" preserveAspectRatio="xMidYMid meet"><path class="draw-path" pathLength="1" d="M4 20 H190 M172 6 L192 20 L172 34" ${stroke(1.7)} /></svg>`;
    case "dot-grid": {
      const dots: string[] = [];
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 9; x++) dots.push(`<circle cx="${10 + x * 22.5}" cy="${10 + y * 20}" r="2.6" />`);
      }
      return `<svg viewBox="0 0 200 100" preserveAspectRatio="xMidYMid meet"><g fill="currentColor">${dots.join("")}</g></svg>`;
    }
  }
}

/** Resolve an image/logo asset reference to something the browser can load, or undefined. */
function resolveAsset(ctx: SceneContext, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const mapped = ctx.assets[ref];
  if (mapped) return mapped;
  const need = ctx.scene.assetNeeds.find((a) => a.id === ref);
  const candidate = need?.resolved ?? ref;
  if (/^https:\/\//i.test(candidate)) return candidate;
  if (/^assets\/[\w./-]+$/.test(candidate) && !candidate.includes("..")) return candidate;
  return undefined;
}

export function renderElement(ctx: SceneContext, el: SceneElement): RenderedElement {
  const id = elementDomId(ctx, el.id);
  const template = ctx.scene.layout.template;
  const sel = `#${id}`;
  const css: string[] = [];
  const cls = ["el", `el-${el.kind}`, `role-${el.role}`];
  if (el.region) cls.push(`region-${el.region}`);
  const open = (extra = "") => `<div id="${id}" class="${cls.join(" ")}"${extra}>`;

  switch (el.kind) {
    case "text": {
      const t = typographyFor(el, template, {});
      css.push(rule(sel, [...typographyCss(ctx, t), "max-width: 100%;", "text-wrap: balance;"]));
      return { id, html: `${open()}${textSpans(el.text, spanMode(ctx, el.id))}</div>`, css };
    }
    case "metric": {
      const t = typographyFor(el, template, {
        font: "display",
        size: el.role === "hero" ? "display-xl" : "display",
        weight: 600,
      });
      css.push(
        rule(`${sel} .metric-value`, [
          ...typographyCss(ctx, t),
          "font-variant-numeric: tabular-nums;",
          "white-space: nowrap;",
        ]),
      );
      const counts = ctx.primitives.get(el.id)?.has("count-up") ?? false;
      const shown = formatMetric(counts ? 0 : el.value, el.decimals);
      const parts = [
        el.prefix ? `<span class="metric-affix">${escapeHtml(el.prefix)}</span>` : "",
        `<span class="metric-num" id="${id}-num">${escapeHtml(shown)}</span>`,
        el.suffix ? `<span class="metric-affix">${escapeHtml(el.suffix)}</span>` : "",
      ].join("");
      let label = "";
      if (el.label) {
        const lt: Typography = {
          font: "body",
          size: el.role === "hero" ? "title" : "body",
          weight: 400,
          color: "muted",
          italic: false,
          uppercase: false,
          align: el.style.align,
        };
        css.push(rule(`${sel} .metric-label`, [...typographyCss(ctx, lt), "max-width: 100%;"]));
        label = `<div class="metric-label">${escapeHtml(el.label)}</div>`;
      }
      return { id, html: `${open()}<div class="metric-value">${parts}</div>${label}</div>`, css };
    }
    case "code": {
      const lines = el.code.split("\n").length;
      const size: SizeToken = lines > 14 ? "label" : lines > 6 ? "caption" : "body";
      const t = typographyFor(el, template, { font: "mono", size, weight: 400, color: "foreground" });
      // Code never wraps (white-space: pre), so shrink the font until the longest line fits the slot.
      const longest = Math.max(1, ...el.code.split("\n").map((l) => [...l.replace(/\t/g, "  ")].length));
      const border = Math.max(1, 2 * ctx.scale);
      const fitPx = Math.floor((slotWidthPx(ctx, el) - 2 * border) / (MONO_ADVANCE_EM * longest + 2.6));
      const fontPx = Math.max(8, Math.min(sizePx(t.size, ctx.scale), fitPx));
      const pad = num(0.9 * fontPx);
      css.push(
        rule(sel, [
          ...typographyCss(ctx, { ...t, align: "start" }),
          `font-size: ${fontPx}px;`,
          "white-space: pre;",
          `background: ${cssColorVar("surface")};`,
          `border: ${num(border)}px solid ${cssColorVar("line")};`,
          `border-radius: ${num(ctx.radiusPx)}px;`,
          `padding: ${pad}px ${num(1.3 * fontPx)}px;`,
          "max-width: 100%;",
          "box-sizing: border-box;",
          "overflow: hidden;",
        ]),
        rule(`${sel} .tk-kw`, [`color: ${cssColorVar("accent")};`]),
        rule(`${sel} .tk-str`, [`color: ${cssColorVar("accent-2")};`]),
        rule(`${sel} .tk-num`, [`color: ${cssColorVar("accent")};`]),
        rule(`${sel} .tk-com, ${sel} .tk-pun`, [`color: ${cssColorVar("muted")};`]),
      );
      const chars = spanMode(ctx, el.id) === "chars";
      return { id, html: `${open()}<code>${codeHtml(el.code, chars)}</code></div>`, css };
    }
    case "list": {
      const t = typographyFor(el, template, {
        size: el.role === "hero" ? "title" : "body",
        weight: el.role === "hero" ? 500 : 400,
      });
      const px = sizePx(t.size, ctx.scale);
      css.push(
        rule(sel, [
          ...typographyCss(ctx, t),
          "list-style: none;",
          "margin: 0;",
          "padding: 0;",
          "display: flex;",
          "flex-direction: column;",
          `gap: ${num(0.55 * px)}px;`,
          "max-width: 100%;",
        ]),
        rule(`${sel} .item`, ["display: flex;", "align-items: baseline;", `gap: ${num(0.6 * px)}px;`]),
        rule(`${sel} .bullet`, [
          "flex: none;",
          `width: ${num(0.7 * px)}px;`,
          `height: ${num(Math.max(2, 0.09 * px))}px;`,
          `background: ${cssColorVar("accent")};`,
          `margin-bottom: ${num(0.3 * px)}px;`,
        ]),
      );
      const items = el.items
        .map(
          (item) =>
            `<li class="item"><span class="bullet"></span><span class="item-text">${escapeHtml(item)}</span></li>`,
        )
        .join("");
      return { id, html: `<ul id="${id}" class="${cls.join(" ")}">${items}</ul>`, css };
    }
    case "shape": {
      const color = cssColorVar(el.style.color ?? (el.shape === "rule" ? "accent" : "line"));
      const s = ctx.scale;
      if (el.shape === "rule") {
        css.push(
          rule(sel, [
            `width: ${num(360 * s)}px;`,
            "max-width: 100%;",
            `height: ${num(Math.max(2, 6 * s))}px;`,
            `background: ${color};`,
            "transform-origin: 0% 50%;",
          ]),
        );
        return { id, html: `${open()}</div>`, css };
      }
      if (el.shape === "box") {
        // A background box frames the whole safe area; a foreground box is a fixed-size panel.
        const { width, height } = ctx.ir.format;
        const inset = ctx.scene.layout.safeArea;
        const [bw, bh] =
          el.role === "background"
            ? [width - 2 * Math.round(inset * width), height - 2 * Math.round(inset * height)]
            : [560 * s, 320 * s];
        css.push(
          rule(sel, [
            `width: ${num(bw)}px;`,
            `height: ${num(bh)}px;`,
            "max-width: 100%;",
            `border: ${num(Math.max(2, 3 * s))}px solid ${color};`,
            `border-radius: ${num(ctx.radiusPx)}px;`,
          ]),
        );
        return { id, html: `${open()}</div>`, css };
      }
      const box: Record<"circle" | "dot-grid" | "bracket" | "arrow", [number, number]> = {
        circle: [260, 260],
        "dot-grid": [520, 260],
        bracket: [80, 260],
        arrow: [360, 72],
      };
      const [w, h] = box[el.shape];
      css.push(
        rule(sel, [
          `width: ${num(w * s)}px;`,
          `height: ${num(h * s)}px;`,
          "max-width: 100%;",
          `color: ${color};`,
        ]),
        rule(`${sel} svg`, ["display: block;", "width: 100%;", "height: 100%;", "overflow: visible;"]),
        rule(`${sel} .draw-path`, ["stroke-dasharray: 1;", "stroke-dashoffset: 0;"]),
      );
      return { id, html: `${open()}${shapeSvg(el.shape)}</div>`, css };
    }
    case "image": {
      const src = resolveAsset(ctx, el.asset);
      const fullBleed = template === "full-bleed" && el.role === "hero";
      const frame = fullBleed
        ? ["position: absolute;", "inset: 0;", "width: 100%;", "height: 100%;"]
        : ["width: 100%;", `max-width: ${num(1100 * ctx.scale)}px;`, `height: ${num(520 * ctx.scale)}px;`];
      if (!src) {
        ctx.warnings.push(
          `scene ${ctx.scene.id}: image "${el.id}" asset "${el.asset}" is unresolved; rendered a placeholder`,
        );
        const lt = typographyFor(el, template, {
          font: "mono",
          size: "caption",
          weight: 400,
          color: "muted",
        });
        css.push(
          rule(sel, [
            ...frame,
            ...typographyCss(ctx, lt),
            `background: ${cssColorVar("surface")};`,
            `border: ${num(Math.max(1, 2 * ctx.scale))}px dashed ${cssColorVar("line")};`,
            `border-radius: ${num(ctx.radiusPx)}px;`,
            "display: flex;",
            "align-items: center;",
            "justify-content: center;",
          ]),
        );
        return { id, html: `${open()}${escapeHtml(el.alt || el.asset)}</div>`, css };
      }
      css.push(
        rule(sel, [...frame, "overflow: hidden;", `border-radius: ${num(fullBleed ? 0 : ctx.radiusPx)}px;`]),
        rule(`${sel} img`, ["display: block;", "width: 100%;", "height: 100%;", `object-fit: ${el.fit};`]),
      );
      return {
        id,
        html: `${open()}<img id="${id}-img" src="${escapeHtml(src)}" alt="${escapeHtml(el.alt)}" /></div>`,
        css,
      };
    }
    case "logo": {
      const src = resolveAsset(ctx, el.asset);
      const t = typographyFor(el, template, {
        font: "display",
        size: el.role === "hero" ? "display" : "title",
        weight: 700,
      });
      if (src) {
        css.push(
          rule(sel, [`height: ${num(sizePx(t.size, ctx.scale) * 1.2)}px;`]),
          rule(`${sel} img`, ["display: block;", "height: 100%;", "width: auto;"]),
        );
        return {
          id,
          html: `${open()}<img id="${id}-img" src="${escapeHtml(src)}" alt="${escapeHtml(el.text)}" /></div>`,
          css,
        };
      }
      css.push(rule(sel, [...typographyCss(ctx, t), "white-space: nowrap;"]));
      return { id, html: `${open()}${textSpans(el.text, spanMode(ctx, el.id))}</div>`, css };
    }
  }
}
