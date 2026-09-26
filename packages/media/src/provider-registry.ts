import { isAbsolute, join, resolve } from "node:path";
import type { Span } from "@motion-mcp/observability";
import { MotionError, newId, toMotionError } from "@motion-mcp/shared";
import { z } from "zod";
import {
  AssetParams,
  CAPABILITY_MATRIX,
  Capability,
  MediaProvider,
  type ProviderRoute,
} from "./capability-matrix.ts";
import type { MediaCommandRunner } from "./multix-runner.ts";
import { type AssetCostEstimate, estimateAssetCost } from "./prices.ts";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export const GenerateAssetRequest = z.object({
  capability: Capability,
  /** Prompt, speech text, or description. Transcription and upscale may leave it empty. */
  prompt: z.string().max(4000).default(""),
  params: AssetParams.default({}),
  /** Providers to try first, in order; remaining available providers follow in matrix order. */
  preferProviders: z.array(MediaProvider).max(9).default([]),
  /** Per-provider model overrides (model ids are configuration, not code). */
  models: z.partialRecord(MediaProvider, z.string().min(1).max(160)).default({}),
  /** Output file stem; defaults to a generated asset id. */
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .optional(),
  /** Absolute output directory; defaults to the registry's directory. */
  outputDir: z.string().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});
export type GenerateAssetRequest = z.input<typeof GenerateAssetRequest>;

export interface AssetAttempt {
  provider: MediaProvider;
  model: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface GeneratedAsset {
  capability: Capability;
  provider: MediaProvider;
  model: string;
  /** Absolute paths of generated files; the first entry is the primary asset. */
  files: string[];
  cost: AssetCostEstimate;
  attempts: AssetAttempt[];
}

export interface ProviderRegistryOptions {
  runner: MediaCommandRunner;
  /** Where provider keys are looked up. Only the chosen route's keys are forwarded to the child. */
  env?: EnvSource;
  /** Default absolute output directory. */
  outputDir: string;
  matrix?: Readonly<Record<Capability, readonly ProviderRoute[]>>;
}

function hasKeys(route: ProviderRoute, env: EnvSource): boolean {
  return route.requiredEnv.every((k) => {
    const v = env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}

/** Cost quantity for one call, in the route's price unit. */
function quantityFor(route: ProviderRoute, prompt: string, params: AssetParams): number {
  switch (route.unit) {
    case "kchar":
      return prompt.length / 1000;
    case "video_second":
    case "audio_second":
      return params.durationSeconds ?? route.defaultQuantity ?? 1;
    case "audio_minute":
      return params.durationSeconds !== undefined
        ? params.durationSeconds / 60
        : (route.defaultQuantity ?? 1);
    default:
      return route.defaultQuantity ?? 1;
  }
}

/**
 * Capability-based media generation over multix with ordered provider fallback and per-asset cost tracing.
 */
export class ProviderRegistry {
  private readonly runner: MediaCommandRunner;
  private readonly env: EnvSource;
  private readonly outputDir: string;
  private readonly matrix: Readonly<Record<Capability, readonly ProviderRoute[]>>;

  constructor(options: ProviderRegistryOptions) {
    if (!isAbsolute(options.outputDir)) throw new MotionError("VALIDATION", "outputDir must be absolute");
    this.runner = options.runner;
    this.env = options.env ?? process.env;
    this.outputDir = options.outputDir;
    this.matrix = options.matrix ?? CAPABILITY_MATRIX;
  }

  /** Routes for a capability whose required keys are present, in matrix order. */
  available(capability: Capability, env: EnvSource = this.env): ProviderRoute[] {
    return (this.matrix[capability] ?? []).filter((route) => hasKeys(route, env));
  }

  /** Capability -> available provider names; safe to show to models (no key material). */
  describe(env: EnvSource = this.env): Record<Capability, MediaProvider[]> {
    const out = {} as Record<Capability, MediaProvider[]>;
    for (const cap of Capability.options) out[cap] = this.available(cap, env).map((r) => r.provider);
    return out;
  }

  /** Available routes ordered by preference, then matrix order. */
  plan(capability: Capability, preferProviders: readonly MediaProvider[] = []): ProviderRoute[] {
    const routes = this.available(capability);
    const preferred = preferProviders
      .map((p) => routes.find((r) => r.provider === p))
      .filter((r): r is ProviderRoute => r !== undefined);
    return [...new Set([...preferred, ...routes])];
  }

  async generateAsset(
    input: GenerateAssetRequest,
    span?: Span,
    signal?: AbortSignal,
  ): Promise<GeneratedAsset> {
    const parsed = GenerateAssetRequest.safeParse(input);
    if (!parsed.success) {
      throw new MotionError("VALIDATION", `invalid asset request: ${z.prettifyError(parsed.error)}`);
    }
    const req = parsed.data;
    const outputDir = req.outputDir ? resolve(req.outputDir) : this.outputDir;
    if (req.outputDir && !isAbsolute(req.outputDir)) {
      throw new MotionError("VALIDATION", "outputDir must be absolute");
    }
    const routes = this.plan(req.capability, req.preferProviders);
    if (routes.length === 0) {
      throw new MotionError("CONFIG", `no media provider configured for ${req.capability}`, {
        details: { capability: req.capability },
      });
    }

    const parent = span?.child(`asset.${req.capability}`, { "asset.capability": req.capability });
    const attempts: AssetAttempt[] = [];
    const stem = req.name ?? newId("asset");
    try {
      for (const [index, route] of routes.entries()) {
        if (signal?.aborted) throw new MotionError("CANCELLED", "asset generation cancelled");
        const model = req.models[route.provider] ?? route.defaultModel;
        const attemptSpan = parent?.child(`asset.${route.provider}`, {
          "asset.provider": route.provider,
          "asset.model": model,
          "asset.attempt": index + 1,
        });
        if (index > 0) parent?.retry();
        const started = Date.now();
        try {
          const argv = route.buildArgv({
            prompt: req.prompt,
            params: req.params,
            output: join(outputDir, `${stem}.${route.ext}`),
            model,
          });
          const providerEnv: Record<string, string> = {};
          for (const key of route.requiredEnv) providerEnv[key] = this.env[key] as string;
          const result = await this.runner.run({
            argv,
            providerEnv,
            outputDir,
            timeoutMs: req.timeoutMs ?? route.timeoutMs,
            signal,
          });
          const cost = estimateAssetCost({
            provider: route.provider,
            model,
            unit: route.unit,
            quantity: quantityFor(route, req.prompt, req.params),
          });
          attemptSpan?.addCost("asset", cost.usd).setAttributes({
            "asset.cost_usd": cost.usd,
            "asset.cost_indicative": true,
            "asset.cost_priced": cost.priced,
            "asset.files": result.files.length,
          });
          attempts.push({ provider: route.provider, model, ok: true, durationMs: Date.now() - started });
          parent?.setAttributes({ "asset.provider": route.provider, "asset.model": model });
          return {
            capability: req.capability,
            provider: route.provider,
            model,
            files: result.files,
            cost,
            attempts,
          };
        } catch (err) {
          const error = toMotionError(err, "PROVIDER");
          attemptSpan?.fail(error);
          attempts.push({
            provider: route.provider,
            model,
            ok: false,
            error: error.message,
            durationMs: Date.now() - started,
          });
          if (error.code === "CANCELLED" || signal?.aborted) throw error;
        } finally {
          attemptSpan?.end();
        }
      }
      throw new MotionError("PROVIDER", `all providers failed for ${req.capability}`, {
        retryable: true,
        details: { capability: req.capability, attempts },
      });
    } catch (err) {
      parent?.fail(err);
      throw err;
    } finally {
      parent?.end();
    }
  }
}
