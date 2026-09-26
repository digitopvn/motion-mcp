import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  type FontRole,
  MotionIR,
  type MotionPrimitive,
  type MotionScene,
  type SceneElement,
  sceneStartTimes,
  totalDuration,
} from "@motion-mcp/motion-ir";
import { MotionError } from "@motion-mcp/shared";
import { elementDomId, type RenderedElement, renderElement, type SceneContext } from "./elements.ts";
import { type FontUsage, planFonts } from "./fonts.ts";
import { effectiveTransitions, TimelineWriter, writeBeat, writeTransition } from "./motion.ts";
import { resolveBeats } from "./timing.ts";
import { COLOR_TOKENS, frameScale, RADIUS_PX_1080, resolvePalette } from "./tokens.ts";
import { cmp, escapeHtml, num, scriptJson } from "./util.ts";

const require = createRequire(import.meta.url);

export const ROOT_COMPOSITION_ID = "main";
export const GSAP_ASSET = "assets/vendor/gsap.min.js";

export interface CompileOptions {
  /**
   * Asset references (element `asset` values or `assetNeeds` ids) mapped to a
   * project-relative path under `assets/` or an https URL. Unmapped references that are
   * neither render as labelled placeholders and produce a warning.
   */
  assets?: Record<string, string>;
}

export interface CompiledProject {
  projectDir: string;
  /** Project-relative paths written, sorted. */
  files: string[];
  compositionId: string;
  /** Total duration in seconds. */
  duration: number;
  /** Scene id → absolute start time in seconds. */
  sceneStarts: Record<string, number>;
  warnings: string[];
}

interface SceneFile {
  path: string;
  body: (fontCss: string) => string;
}

function rule(selector: string, decls: string[]): string {
  return `${selector} {\n${decls.map((d) => `  ${d}`).join("\n")}\n}`;
}

const JUSTIFY: Record<"start" | "center" | "end", string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
};
const TEXT_ALIGN: Record<"start" | "center" | "end", string> = {
  start: "left",
  center: "center",
  end: "right",
};

function collectPrimitives(scene: MotionScene): Map<string, Set<MotionPrimitive>> {
  const map = new Map<string, Set<MotionPrimitive>>();
  for (const b of scene.choreography) {
    const set = map.get(b.target) ?? new Set<MotionPrimitive>();
    set.add(b.primitive);
    map.set(b.target, set);
  }
  return map;
}

const REGION_ORDER: Partial<Record<NonNullable<SceneElement["region"]>, number>> = {
  top: -1,
  middle: 0,
  bottom: 1,
};

function layoutCss(ctx: SceneContext, contentSel: string): string[] {
  const { scene, ir } = ctx;
  const { width, height } = ir.format;
  const { template, align, safeArea } = scene.layout;
  const padX = Math.round(safeArea * width);
  const padY = Math.round(safeArea * height);
  const gap = Math.round(0.035 * Math.min(width, height));
  const base = [
    "position: absolute;",
    `left: ${padX}px;`,
    `top: ${padY}px;`,
    `width: ${width - 2 * padX}px;`,
    `height: ${height - 2 * padY}px;`,
    "box-sizing: border-box;",
    `gap: ${gap}px;`,
    `text-align: ${TEXT_ALIGN[align]};`,
  ];
  const flex = (justify: string) => [
    ...base,
    "display: flex;",
    "flex-direction: column;",
    `justify-content: ${justify};`,
    `align-items: ${JUSTIFY[align]};`,
  ];
  const css: string[] = [];
  switch (template) {
    case "center":
    case "stack":
    case "statement":
      css.push(rule(contentSel, flex("center")));
      break;
    case "lower-third":
    case "full-bleed":
      css.push(rule(contentSel, flex("flex-end")));
      break;
    case "split":
      css.push(
        rule(contentSel, [
          ...base,
          "display: grid;",
          "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);",
          `column-gap: ${Math.round(0.06 * width)}px;`,
          "align-items: center;",
        ]),
        rule(`${contentSel} > .col`, [
          "display: flex;",
          "flex-direction: column;",
          "justify-content: center;",
          `align-items: ${JUSTIFY[align]};`,
          `gap: ${gap}px;`,
          "min-width: 0;",
        ]),
      );
      break;
    case "grid":
      css.push(
        rule(contentSel, flex("center")),
        rule(`${contentSel} > .cells`, [
          "display: grid;",
          `grid-template-columns: repeat(${Math.min(3, Math.max(1, scene.elements.length - 1))}, minmax(0, 1fr));`,
          `gap: ${gap}px;`,
          "width: 100%;",
          "align-items: start;",
        ]),
      );
      break;
  }
  return css;
}

/** Arrange rendered elements into the template's DOM structure. */
function layoutHtml(
  ctx: SceneContext,
  rendered: Map<string, RenderedElement>,
): { content: string; underlay: string } {
  const { scene } = ctx;
  const ordered = scene.elements
    .map((el, i) => ({ el, i }))
    .sort(
      (a, b) =>
        (REGION_ORDER[a.el.region ?? "middle"] ?? 0) - (REGION_ORDER[b.el.region ?? "middle"] ?? 0) ||
        a.i - b.i,
    )
    .map(({ el }) => el);
  const html = (el: SceneElement) => rendered.get(el.id)?.html ?? "";
  const isUnderlay = (el: SceneElement) =>
    el.role === "background" ||
    (scene.layout.template === "full-bleed" && el.role === "hero" && el.kind === "image");
  const underlay = ordered.filter(isUnderlay).map(html).join("\n");
  const flow = ordered.filter((el) => !isUnderlay(el));

  switch (scene.layout.template) {
    case "split": {
      const first =
        flow.find((el) => el.region === "left") ?? flow.find((el) => el.role === "hero") ?? flow[0];
      const a = flow.filter((el) => el === first || (el.region === "left" && el !== first));
      const b = flow.filter((el) => !a.includes(el));
      return {
        underlay,
        content: `<div class="col col-a">${a.map(html).join("\n")}</div>\n<div class="col col-b">${b.map(html).join("\n")}</div>`,
      };
    }
    case "grid": {
      const hero = flow.find((el) => el.role === "hero");
      const cells = flow.filter((el) => el !== hero);
      return {
        underlay,
        content: `${hero ? html(hero) : ""}\n<div class="cells">${cells.map(html).join("\n")}</div>`,
      };
    }
    default:
      return { underlay, content: flow.map(html).join("\n") };
  }
}

function compileScene(
  ir: MotionIR,
  index: number,
  ctxBase: Omit<SceneContext, "scene" | "prefix" | "primitives">,
): SceneFile {
  const scene = ir.scenes[index]!;
  const prefix = `m-${scene.id}__`;
  const ctx: SceneContext = { ...ctxBase, scene, prefix, primitives: collectPrimitives(scene) };
  const { width, height } = ir.format;
  const stageId = `${prefix}stage`;
  const contentId = `${prefix}content`;
  const underlayId = `${prefix}underlay`;

  const rendered = new Map<string, RenderedElement>();
  for (const el of scene.elements) rendered.set(el.id, renderElement(ctx, el));

  const palette = resolvePalette(ir.brand.colors);
  const css: string[] = [
    rule(`#${stageId}`, [
      ...COLOR_TOKENS.map((t) => `--c-${t}: ${palette[t]};`),
      "position: absolute;",
      "left: 0;",
      "top: 0;",
      `width: ${width}px;`,
      `height: ${height}px;`,
      "overflow: hidden;",
      `background: var(--c-${scene.layout.background});`,
      `color: var(--c-foreground);`,
      `font-family: ${ctx.fontStacks.body};`,
    ]),
    rule(`#${underlayId}`, [
      "position: absolute;",
      "inset: 0;",
      "display: flex;",
      "align-items: center;",
      "justify-content: center;",
    ]),
    rule(`#${stageId} .el`, ["box-sizing: border-box;", "margin: 0;", "min-width: 0;"]),
    rule(`#${stageId} .w, #${stageId} .item`, ["display: inline-block;"]),
    rule(`#${stageId} .item`, ["display: flex;"]),
    ...layoutCss(ctx, `#${contentId}`),
    ...[...rendered.values()].flatMap((r) => r.css),
  ];

  // Timeline: transitions on the stage, then beats in authored order.
  const w = new TimelineWriter();
  const t = effectiveTransitions(ir.scenes, index);
  writeTransition(w, `#${stageId}`, "in", t.in.kind, t.in.duration, scene.duration);
  const byId = new Map(scene.elements.map((el) => [el.id, el] as const));
  for (const rb of resolveBeats(scene)) {
    const el = byId.get(rb.beat.target);
    if (el) writeBeat(w, ctx, el, rb, ir.format);
  }
  writeTransition(w, `#${stageId}`, "out", t.out.kind, t.out.duration, scene.duration);

  const { content, underlay } = layoutHtml(ctx, rendered);
  const script = [
    "(function () {",
    "  var tl = gsap.timeline({ paused: true });",
    ...w.preamble().map((l) => `  ${l}`),
    ...w.lines.map((l) => `  ${l}`),
    `  tl.set({}, {}, ${num(scene.duration)});`,
    "  window.__timelines = window.__timelines || {};",
    `  window.__timelines[${scriptJson(scene.id)}] = tl;`,
    "})();",
  ].join("\n");

  const body = (fontCss: string) =>
    [
      `<template id="${prefix}template">`,
      `  <div data-composition-id="${scene.id}" data-width="${width}" data-height="${height}" data-duration="${num(scene.duration)}">`,
      `    <div id="${stageId}" data-scene-role="${scene.role}">`,
      `      <div id="${underlayId}">${underlay}</div>`,
      `      <div id="${contentId}" data-layout="${scene.layout.template}">`,
      indent(content, 8),
      "      </div>",
      "    </div>",
      "    <style>",
      indent([fontCss, ...css].filter(Boolean).join("\n"), 6),
      "    </style>",
      "    <script>",
      indent(script, 6),
      "    </script>",
      "  </div>",
      "</template>",
      "",
    ].join("\n");

  return { path: `compositions/${scene.id}.html`, body };
}

/**
 * Indent generated markup for readability. Lines inside `<code>…</code>` are left untouched:
 * code blocks use `white-space: pre`, so added indentation would render as visible spaces.
 */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  let inPre = false;
  return text
    .split("\n")
    .map((line) => {
      const out = line.length > 0 && !inPre ? pad + line : line;
      const opens = line.lastIndexOf("<code>");
      const closes = line.lastIndexOf("</code>");
      if (opens > closes) inPre = true;
      else if (closes > opens) inPre = false;
      return out;
    })
    .join("\n");
}

function indexHtml(ir: MotionIR, duration: number, starts: number[], background: string): string {
  const { width, height } = ir.format;
  const hosts = ir.scenes.map((scene, i) =>
    [
      `      <div id="scene-${scene.id}" class="scene-host" data-composition-id="${scene.id}"`,
      `        data-composition-src="compositions/${scene.id}.html" data-start="${num(starts[i] ?? 0)}"`,
      `        data-duration="${num(scene.duration)}" data-track-index="1"></div>`,
    ].join("\n"),
  );
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    `    <meta name="viewport" content="width=${width}, height=${height}" />`,
    `    <title>${escapeHtml(ir.title ?? ir.id)}</title>`,
    `    <script src="${GSAP_ASSET}"></script>`,
    "    <style>",
    `      html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }`,
    `      #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }`,
    `      .scene-host { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; }`,
    "    </style>",
    "  </head>",
    "  <body>",
    `    <div id="root" data-composition-id="${ROOT_COMPOSITION_ID}" data-start="0" data-duration="${num(duration)}" data-width="${width}" data-height="${height}">`,
    ...hosts,
    "    </div>",
    "    <script>",
    "      (function () {",
    "        var tl = gsap.timeline({ paused: true });",
    `        tl.set({}, {}, ${num(duration)});`,
    "        window.__timelines = window.__timelines || {};",
    `        window.__timelines[${scriptJson(ROOT_COMPOSITION_ID)}] = tl;`,
    "      })();",
    "    </script>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

const HYPERFRAMES_JSON = `${JSON.stringify(
  {
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
    media: { autoProxy: true },
  },
  null,
  2,
)}\n`;

/**
 * Compile a Motion IR into a HyperFrames project directory. Output is deterministic:
 * the same IR (and options) always produces byte-identical files.
 */
export async function compileProject(
  input: MotionIR,
  outDir: string,
  opts: CompileOptions = {},
): Promise<CompiledProject> {
  const parsed = MotionIR.safeParse(input);
  if (!parsed.success) {
    throw new MotionError("VALIDATION", "invalid Motion IR", {
      details: { issues: parsed.error.issues.slice(0, 20) },
    });
  }
  const ir = parsed.data;
  for (const [ref, target] of Object.entries(opts.assets ?? {})) {
    if (!/^https:\/\//i.test(target) && !(/^assets\/[\w./-]+$/.test(target) && !target.includes(".."))) {
      throw new MotionError("VALIDATION", `asset "${ref}" must map to an https URL or a path under assets/`);
    }
  }

  const projectDir = resolve(outDir);
  const duration = totalDuration(ir);
  const starts = sceneStartTimes(ir);
  const warnings: string[] = [];
  const scale = frameScale(ir.format);
  const usage: Record<FontRole, FontUsage> = {
    display: { weights: new Set(), italic: false },
    body: { weights: new Set([400]), italic: false },
    mono: { weights: new Set(), italic: false },
  };
  // Font stacks are needed while rendering elements; resolve names first, files after usage is known.
  const namePlan = planFonts(ir.brand.fonts, usage);
  const ctxBase = {
    ir,
    scale,
    radiusPx: RADIUS_PX_1080[ir.brand.radius] * scale,
    fontStacks: {
      display: namePlan.fonts.display.stack,
      body: namePlan.fonts.body.stack,
      mono: namePlan.fonts.mono.stack,
    },
    fontUsage: usage,
    assets: opts.assets ?? {},
    warnings,
  };
  const sceneFiles = ir.scenes.map((_, i) => compileScene(ir, i, ctxBase));
  const fonts = planFonts(ir.brand.fonts, usage);
  warnings.unshift(...fonts.warnings);

  const palette = resolvePalette(ir.brand.colors);
  const outputs = new Map<string, string>();
  outputs.set(
    "index.html",
    indexHtml(ir, duration, starts, palette[ir.scenes[0]?.layout.background ?? "background"]),
  );
  for (const sf of sceneFiles) outputs.set(sf.path, sf.body(fonts.css));
  outputs.set("hyperframes.json", HYPERFRAMES_JSON);
  outputs.set("motion-ir.json", `${JSON.stringify(ir, null, 2)}\n`);

  const copies = new Map<string, string>();
  copies.set(GSAP_ASSET, require.resolve("gsap/dist/gsap.min.js"));
  for (const f of fonts.files) copies.set(f.dest, f.source);

  try {
    await mkdir(join(projectDir, "compositions"), { recursive: true });
    // Remove compositions of scenes that no longer exist so the project mirrors the IR.
    const current = new Set(sceneFiles.map((s) => s.path.slice("compositions/".length)));
    for (const entry of await readdir(join(projectDir, "compositions"))) {
      if (entry.endsWith(".html") && !current.has(entry)) await rm(join(projectDir, "compositions", entry));
    }
    for (const [rel, content] of outputs) {
      await mkdir(dirname(join(projectDir, rel)), { recursive: true });
      await writeFile(join(projectDir, rel), content, "utf8");
    }
    for (const [rel, source] of copies) {
      await mkdir(dirname(join(projectDir, rel)), { recursive: true });
      await copyFile(source, join(projectDir, rel));
    }
  } catch (err) {
    throw new MotionError("INTERNAL", `failed to write HyperFrames project to ${projectDir}`, { cause: err });
  }

  return {
    projectDir,
    files: [...outputs.keys(), ...copies.keys()].sort(cmp),
    compositionId: ROOT_COMPOSITION_ID,
    duration,
    sceneStarts: Object.fromEntries(ir.scenes.map((s, i) => [s.id, starts[i] ?? 0])),
    warnings,
  };
}

export { elementDomId };
