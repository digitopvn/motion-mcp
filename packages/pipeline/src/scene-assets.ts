import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { creditsToUsd, type JobPlan, type JobQuote, priceOf, quoteJob } from "@motion-mcp/billing";
import { shouldGenerateAsset } from "@motion-mcp/jev-router";
import { type EnvSource, type MediaCommandRunner, multixEnvKeys, ProviderRegistry } from "@motion-mcp/media";
import type { AssetNeed, MotionIR, MotionScene } from "@motion-mcp/motion-ir";
import { toMotionError } from "@motion-mcp/shared";
import { artifactKey } from "@motion-mcp/storage";
import type { JobScope } from "./build-version.ts";
import type { PipelineRuntime } from "./runtime.ts";

/** How the pipeline runs multix: the CLI runner plus the server's own media keys (possibly none). */
export interface MediaRuntime {
  runner: MediaCommandRunner;
  serverEnv: Record<string, string>;
}

/** Where generated images live inside a compiled project; the compiler accepts `assets/...` paths. */
export const GENERATED_ASSET_PREFIX = "assets/generated/";

const IMAGE_KINDS = new Set<AssetNeed["kind"]>(["image", "texture", "icon", "logo"]);
const GENERATED_NAME = /^[a-z0-9][a-z0-9_-]*\.(png|jpe?g|webp)$/;
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** The server's multix keys from its environment, limited to names multix providers declare. */
export function serverMediaEnv(env: EnvSource = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name } of multixEnvKeys()) {
    const value = env[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
}

export interface ImageSource {
  env: Record<string, string>;
  /** The workspace's own keys pay for the images. */
  byok: boolean;
}

/**
 * Keys for image generation: the workspace's own keys when they unlock an image provider, else the
 * server's. The two are never mixed, so a BYOK image is always paid by the workspace.
 */
export async function imageSource(
  rt: PipelineRuntime,
  workspaceId: string,
): Promise<ImageSource | undefined> {
  if (!rt.media || rt.config.ASSET_IMAGES_PER_JOB === 0) return undefined;
  const probe = new ProviderRegistry({ runner: rt.media.runner, outputDir: rt.workDir });
  const workspaceEnv = await rt.providers.multixEnv(workspaceId).catch((err: unknown) => {
    rt.logger.warn("assets.workspace_keys_unavailable", { workspaceId, message: toMotionError(err).message });
    return {};
  });
  if (probe.available("image.generate", workspaceEnv).length > 0) return { env: workspaceEnv, byok: true };
  if (probe.available("image.generate", rt.media.serverEnv).length > 0) {
    return { env: rt.media.serverEnv, byok: false };
  }
  return undefined;
}

/**
 * Quote a create/edit job with its image allowance. Images are reserved up front like every other
 * worst case; unused ones are released at capture. An explicit budget shrinks the allowance instead of
 * failing a job that fits without images.
 */
export async function quoteWithAssets(
  rt: PipelineRuntime,
  workspaceId: string,
  plan: JobPlan,
  budgetCredits?: number,
): Promise<{ quote: JobQuote; assetImages: number }> {
  const base = quoteJob(plan);
  const source = await imageSource(rt, workspaceId);
  if (!source) return { quote: base, assetImages: 0 };
  const cap = rt.config.ASSET_IMAGES_PER_JOB;
  if (source.byok) return { quote: quoteJob({ ...plan, images: cap, byok: true }), assetImages: cap };
  const room =
    budgetCredits === undefined
      ? cap
      : Math.floor((budgetCredits - base.totalCredits) / priceOf("image_generation", 1));
  const assetImages = Math.max(0, Math.min(cap, room));
  return { quote: assetImages > 0 ? quoteJob({ ...plan, images: assetImages }) : base, assetImages };
}

interface Wanted {
  scene: MotionScene;
  need: AssetNeed;
}

/** Image needs to generate: unresolved, marked `generate`, and actually shown by an image or logo element. */
function wantedNeeds(ir: MotionIR): Wanted[] {
  const out: Wanted[] = [];
  for (const scene of ir.scenes) {
    for (const need of scene.assetNeeds) {
      if (need.source !== "generate" || need.resolved || !IMAGE_KINDS.has(need.kind)) continue;
      const shown = scene.elements.some(
        (el) => (el.kind === "image" || el.kind === "logo") && el.asset === need.id,
      );
      if (shown) out.push({ scene, need });
    }
  }
  return out.sort((a, b) => Number(b.need.required) - Number(a.need.required));
}

const ASPECTS: Array<[string, number]> = [
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["1:1", 1],
  ["4:5", 4 / 5],
];

/** Full-bleed hero images match the frame; icons and logos are square; other images are landscape. */
function aspectFor(ir: MotionIR, scene: MotionScene, need: AssetNeed): string {
  if (need.kind === "icon" || need.kind === "logo") return "1:1";
  const fullBleed =
    scene.layout.template === "full-bleed" &&
    scene.elements.some((el) => el.kind === "image" && el.asset === need.id && el.role === "hero");
  if (!fullBleed) return "16:9";
  const ratio = ir.format.width / ir.format.height;
  return ASPECTS.reduce((best, cur) =>
    Math.abs(cur[1] - ratio) < Math.abs(best[1] - ratio) ? cur : best,
  )[0];
}

const KIND_HINT: Record<AssetNeed["kind"], string> = {
  image: "",
  texture: "A subtle, seamless abstract texture suitable as a background.",
  icon: "A simple, flat icon centered on a plain background.",
  logo: "A minimal logo mark centered on a plain background.",
  video: "",
  audio: "",
};

/** The need's description in the video's visual language; generated images never carry text. */
export function assetPrompt(ir: MotionIR, need: AssetNeed): string {
  const colors = Object.values(ir.brand.colors).filter(Boolean).join(", ");
  const parts = [
    need.description,
    KIND_HINT[need.kind],
    `Visual language: ${ir.creative.concept}`,
    ir.creative.mood.length > 0 ? `Mood: ${ir.creative.mood.join(", ")}.` : "",
    colors ? `Palette: ${colors}.` : "",
    ir.motionLanguage.avoid.length > 0 ? `Avoid: ${ir.motionLanguage.avoid.join("; ")}.` : "",
    "No text, letters, captions or watermarks.",
  ];
  return parts
    .filter((p) => p.trim() !== "")
    .join("\n")
    .slice(0, 4000);
}

/** A fresh file stem per generation, so an older version never picks up a newer image. */
function stemFor(scene: MotionScene, need: AssetNeed): string {
  const base = `${scene.id}-${need.id}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 48);
  return `${base || "asset"}-${randomBytes(3).toString("hex")}`;
}

const localAssetDir = (rt: PipelineRuntime, projectId: string) => join(rt.workDir, projectId, "assets");

const assetStoreKey = (scope: Pick<JobScope, "workspaceId" | "projectId">, name: string) =>
  artifactKey({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    kind: "assets",
    name: `generated/${name}`,
  });

/**
 * Generate the images scenes call for, within the job's allowance, and point each need at its file.
 * A failed or skipped image leaves the need unresolved, which the compiler renders as a labelled
 * placeholder, and adds a warning; generation never fails the job.
 */
export async function generateSceneAssets(scope: JobScope, ir: MotionIR): Promise<MotionIR> {
  const { rt } = scope;
  const wanted = wantedNeeds(ir);
  if (wanted.length === 0 || !rt.media) return ir;
  const source = await imageSource(rt, scope.workspaceId);
  if (!source) {
    scope.warnings.push(
      `${wanted.length} scene image(s) were not generated: no image provider key (add one under Model providers)`,
    );
    return ir;
  }
  if (scope.assetImages === 0) {
    scope.warnings.push(
      `${wanted.length} scene image(s) were not generated: the job's budget does not cover them`,
    );
    return ir;
  }
  await scope.progress("assets", 0.08, `Generating ${Math.min(wanted.length, scope.assetImages)} image(s)`);
  const outputDir = localAssetDir(rt, scope.projectId);
  const registry = new ProviderRegistry({ runner: rt.media.runner, env: source.env, outputDir });
  const next: MotionIR = structuredClone(ir);
  const perImageUsd = creditsToUsd(priceOf("image_generation", 1));
  let generated = 0;
  const skipped: string[] = [];

  await scope.span.run("assets.generate", async (span) => {
    for (const { scene, need } of wanted) {
      const verdict = shouldGenerateAsset({
        byok: source.byok,
        generatedForJob: generated,
        maxPerJob: scope.assetImages,
        budgetRemainingUsd: scope.meter.remainingUsd(),
        estimatedCostUsd: perImageUsd,
      });
      if (!verdict.ok) {
        skipped.push(`${scene.id}/${need.id} (${verdict.reason})`);
        continue;
      }
      try {
        const asset = await registry.generateAsset(
          {
            capability: "image.generate",
            prompt: assetPrompt(ir, need),
            params: { aspectRatio: aspectFor(ir, scene, need) },
            name: stemFor(scene, need),
          },
          span,
          scope.signal,
        );
        const file = asset.files[0] as string;
        const name = basename(file).toLowerCase();
        const mime = MIME[extname(name)];
        if (!GENERATED_NAME.test(name) || !mime)
          throw new Error(`unexpected image file type ${extname(name)}`);
        await scope.rt.store.put(assetStoreKey(scope, name), { path: file }, mime);
        const target = next.scenes.find((s) => s.id === scene.id)?.assetNeeds.find((n) => n.id === need.id);
        if (target) target.resolved = `${GENERATED_ASSET_PREFIX}${name}`;
        scope.meter.add("image_generation", 1, { byok: source.byok });
        generated += 1;
      } catch (err) {
        if (scope.signal.aborted) throw err;
        scope.warnings.push(
          `Scene ${scene.id}: image "${need.id}" was not generated (${toMotionError(err).message}); rendered a placeholder`,
        );
      }
    }
    span.setAttributes({
      "assets.wanted": wanted.length,
      "assets.generated": generated,
      "assets.byok": source.byok,
    });
  });
  if (skipped.length > 0) {
    scope.warnings.push(`${skipped.length} scene image(s) skipped: ${skipped.join(", ")}`);
  }
  return next;
}

/**
 * Copy the version's generated images into its compiled project. Compiling wipes the project directory,
 * so this runs after every compile; files come from the local cache, else from artifact storage.
 */
export async function materializeGeneratedAssets(
  scope: Pick<JobScope, "rt" | "workspaceId" | "projectId">,
  ir: MotionIR,
  dir: string,
): Promise<number> {
  const names = new Set<string>();
  for (const scene of ir.scenes) {
    for (const need of scene.assetNeeds) {
      const ref = need.resolved;
      if (!ref?.startsWith(GENERATED_ASSET_PREFIX)) continue;
      const name = ref.slice(GENERATED_ASSET_PREFIX.length);
      if (GENERATED_NAME.test(name)) names.add(name);
    }
  }
  if (names.size === 0) return 0;
  const targetDir = join(dir, GENERATED_ASSET_PREFIX);
  await mkdir(targetDir, { recursive: true });
  const cache = localAssetDir(scope.rt, scope.projectId);
  for (const name of names) {
    const target = join(targetDir, name);
    if (existsSync(target)) continue;
    const cached = join(cache, name);
    try {
      if (existsSync(cached)) await copyFile(cached, target);
      else await writeFile(target, await scope.rt.store.get(assetStoreKey(scope, name)));
    } catch (err) {
      // The check then reports the missing file, which blocks a final render of this version.
      scope.rt.logger.warn("assets.materialize_failed", {
        projectId: scope.projectId,
        name,
        message: toMotionError(err).message,
      });
    }
  }
  return names.size;
}
