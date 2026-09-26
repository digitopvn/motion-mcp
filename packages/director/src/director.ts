import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { type ContentPart, chat, type ModelGateway } from "@motion-mcp/llm";
import { AspectPreset, CreativeSpec, type ScenePatch } from "@motion-mcp/motion-ir";
import type { ModelUsage, Span } from "@motion-mcp/observability";
import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";
import { type SceneCritiqueBundle, scenePatchSchemaFor } from "./critique-bundle.ts";
import type { DirectorMode } from "./director-mode.ts";
import { CRITIC_SYSTEM_PROMPT, DIRECTOR_SYSTEM_PROMPT } from "./prompts.ts";

export interface DirectorOptions {
  /** Required for internal-opus/custom. Host mode never calls it. */
  gateway?: ModelGateway;
  /** Configured director model id (DIRECTOR_MODEL). */
  directorModel: string;
  specMaxTokens?: number;
  critiqueMaxTokens?: number;
  temperature?: number;
}

export const SpecFormatRequest = z.object({
  aspect: AspectPreset.optional(),
  fps: z.number().int().min(12).max(60).optional(),
  duration: z.number().positive().max(600).optional(),
});
export type SpecFormatRequest = z.infer<typeof SpecFormatRequest>;

export interface CreateCreativeSpecInput {
  brief: string;
  format?: SpecFormatRequest;
  /** Recipe name plus its defaults, as a short text. */
  recipe?: string;
  /** Retrieved Taste Memory preferences (snippets, not documents). */
  tasteContext?: string[];
  /** Retrieved domain-pack snippets (snippets, not documents). */
  domainContext?: string[];
  mode: DirectorMode;
  /** Planner model for `custom` mode. */
  customModel?: string;
  /** Host-authored spec for `host-opus` mode. */
  creativeSpec?: unknown;
  signal?: AbortSignal;
}

export interface CreativeSpecResult {
  spec: CreativeSpec;
  mode: DirectorMode;
  source: "host" | "model";
  model?: string;
  modelCalls: ModelUsage[];
}

export interface CritiqueOptions {
  mode: DirectorMode;
  customModel?: string;
  signal?: AbortSignal;
}

export interface CritiqueResult {
  patch: ScenePatch;
  model: string;
  modelCalls: ModelUsage[];
}

const MAX_BRIEF_CHARS = 6000;
const MAX_SNIPPETS = 8;
const MAX_SNIPPET_CHARS = 1500;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Spec schema plus referential checks the IR compiler would otherwise reject later. */
export const DirectorSpecSchema = CreativeSpec.superRefine((spec, ctx) => {
  const sceneIds = new Set<string>();
  for (const [si, scene] of spec.scenes.entries()) {
    if (sceneIds.has(scene.id)) {
      ctx.addIssue({ code: "custom", message: `duplicate scene id ${scene.id}`, path: ["scenes", si, "id"] });
    }
    sceneIds.add(scene.id);
    const ids = new Set<string>();
    for (const [ei, el] of scene.elements.entries()) {
      if (ids.has(el.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate element id ${el.id}`,
          path: ["scenes", si, "elements", ei],
        });
      }
      ids.add(el.id);
    }
    for (const [bi, beat] of (scene.choreography ?? []).entries()) {
      const refs = [beat.target];
      if (typeof beat.at === "object") refs.push("after" in beat.at ? beat.at.after : beat.at.with);
      for (const ref of refs) {
        if (ref !== "scene" && !ids.has(ref)) {
          ctx.addIssue({
            code: "custom",
            message: `beat references unknown element "${ref}"`,
            path: ["scenes", si, "choreography", bi],
          });
        }
      }
    }
  }
});

/**
 * The director turns briefs into CreativeSpecs (Stage 1+2) and critiques single scenes (Stage 3).
 * It never writes renderer code. Every model call is recorded on the caller's span.
 */
export class Director {
  private readonly options: DirectorOptions;

  constructor(options: DirectorOptions) {
    if (!options.directorModel) throw new MotionError("CONFIG", "DIRECTOR_MODEL is not configured");
    this.options = options;
  }

  async createCreativeSpec(input: CreateCreativeSpecInput, span: Span): Promise<CreativeSpecResult> {
    if (input.mode === "host-opus") {
      return span.run("director.host_spec", async (s) => {
        s.setAttributes({ "director.mode": "host-opus", "director.model_calls": 0 });
        if (input.creativeSpec === undefined) {
          throw new MotionError("VALIDATION", "host-opus mode requires a creativeSpec");
        }
        const parsed = DirectorSpecSchema.safeParse(input.creativeSpec);
        if (!parsed.success) {
          throw new MotionError("VALIDATION", "creativeSpec failed validation", {
            details: { issues: parsed.error.issues.slice(0, 30), summary: z.prettifyError(parsed.error) },
          });
        }
        return {
          spec: applyFormat(parsed.data, input.format),
          mode: "host-opus",
          source: "host",
          modelCalls: [],
        };
      });
    }

    const brief = input.brief?.trim();
    if (!brief) throw new MotionError("VALIDATION", "brief is required");
    if (brief.length > MAX_BRIEF_CHARS) {
      throw new MotionError("VALIDATION", `brief exceeds ${MAX_BRIEF_CHARS} characters`);
    }
    const format = input.format ? parseFormat(input.format) : undefined;
    const model = this.modelFor(input.mode, input.customModel);
    const gateway = this.requireGateway();

    return span.run(
      "director.spec",
      async (s) => {
        const context = buildContextBlock(input.recipe, input.domainContext, input.tasteContext);
        const content: ContentPart[] = [];
        if (context) content.push({ type: "text", text: context, cache: true });
        content.push({ type: "text", text: buildBriefBlock(brief, format) });
        const result = await chat(gateway, {
          model,
          messages: [
            { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
            { role: "user", content },
          ],
          responseSchema: { name: "creative_spec", schema: DirectorSpecSchema },
          maxTokens: this.options.specMaxTokens ?? 4096,
          temperature: this.options.temperature ?? 0.7,
          cache: true,
          signal: input.signal,
          span: s,
        });
        const spec = applyFormat(result.parsed as CreativeSpec, format);
        s.setAttributes({
          "director.scenes": spec.scenes.length,
          "director.model_calls": result.calls.length,
          "director.output_tokens": result.usage.outputTokens,
        });
        return { spec, mode: input.mode, source: "model" as const, model, modelCalls: result.calls };
      },
      { "director.mode": input.mode, "director.model": model },
    );
  }

  /** Stage 3: one scene-isolated structured call returning a ScenePatch (source "opus"). */
  async critiqueScene(
    bundle: SceneCritiqueBundle,
    span: Span,
    options: CritiqueOptions,
  ): Promise<CritiqueResult> {
    if (options.mode === "host-opus") {
      throw new MotionError(
        "VALIDATION",
        "host-opus critiques are authored by the host; use buildHostCritiqueRequest instead of critiqueScene",
      );
    }
    const model = this.modelFor(options.mode, options.customModel);
    const gateway = this.requireGateway();
    const sceneId = bundle.sceneIR.id;

    return span.run(
      "director.critique",
      async (s) => {
        const { contactSheet, prevFrame, nextFrame, ...textual } = bundle;
        const content: ContentPart[] = [
          { type: "text", text: `Scene critique bundle:\n${JSON.stringify(textual)}` },
        ];
        if (prevFrame)
          content.push({ type: "text", text: "Previous scene, last frame:" }, await imagePart(prevFrame));
        content.push(
          { type: "text", text: `Contact sheet for scene ${sceneId}:` },
          await imagePart(contactSheet),
        );
        if (nextFrame)
          content.push({ type: "text", text: "Next scene, first frame:" }, await imagePart(nextFrame));

        const result = await chat(gateway, {
          model,
          messages: [
            { role: "system", content: CRITIC_SYSTEM_PROMPT },
            { role: "user", content },
          ],
          responseSchema: { name: "scene_patch", schema: scenePatchSchemaFor(bundle) },
          maxTokens: this.options.critiqueMaxTokens ?? 2000,
          temperature: 0.4,
          cache: true,
          signal: options.signal,
          span: s,
        });
        const parsed = result.parsed as ScenePatch;
        const patch: ScenePatch = { ...parsed, sceneId, source: "opus" };
        s.setAttributes({
          "critique.changes": patch.changes.length,
          "director.model_calls": result.calls.length,
        });
        return { patch, model, modelCalls: result.calls };
      },
      { "director.mode": options.mode, "director.model": model, "scene.id": sceneId },
    );
  }

  private modelFor(mode: DirectorMode, customModel?: string): string {
    if (mode === "custom") {
      if (!customModel) throw new MotionError("VALIDATION", 'directorMode "custom" requires customModel');
      return customModel;
    }
    return this.options.directorModel;
  }

  private requireGateway(): ModelGateway {
    if (!this.options.gateway) {
      throw new MotionError(
        "CONFIG",
        "No model gateway configured (OPENROUTER_API_KEY missing); use host-opus mode",
      );
    }
    return this.options.gateway;
  }
}

function parseFormat(format: SpecFormatRequest): SpecFormatRequest {
  const parsed = SpecFormatRequest.safeParse(format);
  if (!parsed.success) {
    throw new MotionError("VALIDATION", `invalid format: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Explicit caller format always wins over what the director chose. */
function applyFormat(spec: CreativeSpec, format: SpecFormatRequest | undefined): CreativeSpec {
  if (!format || (format.aspect === undefined && format.fps === undefined)) return spec;
  return {
    ...spec,
    format: {
      aspect: format.aspect ?? spec.format?.aspect ?? "16:9",
      fps: format.fps ?? spec.format?.fps ?? 30,
    },
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildContextBlock(recipe?: string, domain?: string[], taste?: string[]): string | undefined {
  const sections: string[] = [];
  if (recipe?.trim()) sections.push(`Recipe defaults:\n${clip(recipe.trim(), MAX_SNIPPET_CHARS)}`);
  const snippets = (label: string, items?: string[]) => {
    const kept = (items ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_SNIPPETS);
    if (kept.length)
      sections.push(`${label}:\n${kept.map((s) => `- ${clip(s, MAX_SNIPPET_CHARS)}`).join("\n")}`);
  };
  snippets("Domain guidance (retrieved snippets)", domain);
  snippets("Workspace taste preferences", taste);
  return sections.length ? sections.join("\n\n") : undefined;
}

function buildBriefBlock(brief: string, format?: SpecFormatRequest): string {
  const lines = [`Brief:\n${brief}`];
  if (format?.aspect) lines.push(`Aspect: ${format.aspect}`);
  if (format?.fps) lines.push(`FPS: ${format.fps}`);
  if (format?.duration)
    lines.push(`Target duration: ${format.duration} s (scene durations must sum to this)`);
  lines.push("Return the CreativeSpec JSON.");
  return lines.join("\n");
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Frame reference to an image part: data/https URLs pass through, local files become data URLs. */
async function imagePart(ref: string): Promise<ContentPart> {
  if (ref.startsWith("data:image/") || ref.startsWith("https://")) return { type: "image", url: ref };
  const mime = MIME[extname(ref).toLowerCase()];
  if (!mime) throw new MotionError("VALIDATION", `Unsupported frame image type: ${extname(ref) || "(none)"}`);
  const info = await stat(ref).catch((err: unknown) => {
    throw new MotionError("NOT_FOUND", `Frame image not found: ${ref}`, { cause: err });
  });
  if (info.size > MAX_IMAGE_BYTES) throw new MotionError("VALIDATION", `Frame image too large: ${ref}`);
  const data = await readFile(ref);
  return { type: "image", url: `data:${mime};base64,${data.toString("base64")}` };
}
