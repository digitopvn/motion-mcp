import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";
import type { PriceUnit } from "./prices.ts";

/**
 * Static capability matrix: capability -> ordered provider routes -> argv builder -> required env keys.
 * multix has no capabilities command and no JSON output, so this table (checked against
 * `multix <group> <command> --help` of the pinned version) is the contract.
 */

export const Capability = z.enum([
  "image.generate",
  "image.edit",
  "image.upscale",
  "video.t2v",
  "video.i2v",
  "audio.tts",
  "audio.stt",
  "audio.music",
  "audio.sfx",
]);
export type Capability = z.infer<typeof Capability>;

export const MediaProvider = z.enum([
  "gemini",
  "openai",
  "openrouter",
  "minimax",
  "fal",
  "cloudflare",
  "elevenlabs",
  "leonardo",
  "byteplus",
]);
export type MediaProvider = z.infer<typeof MediaProvider>;

const Ratio = z.string().regex(/^\d{1,2}:\d{1,2}$/, "aspect ratio like 16:9");
const SafeToken = z.string().regex(/^[A-Za-z0-9_.:/@-]{1,120}$/, "letters, digits and _.:/@- only");

/** Validated per-request knobs. Builders read what they support and ignore the rest. */
export const AssetParams = z.object({
  aspectRatio: Ratio.optional(),
  /** Image size hint (`1024x1024`, `2K`, ...). */
  size: z
    .string()
    .regex(/^(\d{3,4}x\d{3,4}|[124]K|auto)$/)
    .optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
  durationSeconds: z.number().positive().max(120).optional(),
  voice: SafeToken.optional(),
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
  /** Local file path or https URL of a source image (edit, i2v, upscale). */
  inputImage: z.string().min(1).max(2048).optional(),
  /** Local file path of source audio/video (stt). */
  inputFile: z.string().min(1).max(2048).optional(),
});
export type AssetParams = z.infer<typeof AssetParams>;

export interface ArgvInput {
  prompt: string;
  params: AssetParams;
  /** Absolute output file path chosen by the registry. */
  output: string;
  model: string;
}

export interface ProviderRoute {
  provider: MediaProvider;
  defaultModel: string;
  /** Every key must be present for the route to be available; only these keys reach the child. */
  requiredEnv: readonly string[];
  /** Output file extension (without dot). */
  ext: string;
  unit: PriceUnit;
  /** Default quantity for cost estimation when the request does not say (e.g. default clip length). */
  defaultQuantity?: number;
  timeoutMs?: number;
  buildArgv(input: ArgvInput): string[];
}

const VIDEO_TIMEOUT_MS = 15 * 60 * 1000;

/** `--flag=value` keeps model-authored text from ever being parsed as another option. */
const opt = (name: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [`--${name}=${value}`];
const out = (path: string): string[] => ["--output", path];
/** Positional prompts go after `--` so a leading dash cannot become an option. */
const positional = (value: string): string[] => ["--", value];

function need<T>(value: T | undefined, what: string, provider: string): T {
  if (value === undefined || value === "") {
    throw new MotionError("VALIDATION", `${provider} requires params.${what}`);
  }
  return value;
}

function needUrl(value: string | undefined, what: string, provider: string): string {
  const v = need(value, what, provider);
  if (!/^https:\/\//i.test(v))
    throw new MotionError("VALIDATION", `${provider} requires params.${what} as an https URL`);
  return v;
}

const minimaxResolution = (r: AssetParams["resolution"]) => (r === "720p" ? "720P" : "1080P");
const minimaxDuration = (s: number | undefined) => (s !== undefined && s > 6 ? 10 : 6);
const modelFlag = (model: string, def: string) => (model === def ? [] : opt("model", model));

export const CAPABILITY_MATRIX: Readonly<Record<Capability, readonly ProviderRoute[]>> = {
  "image.generate": [
    {
      provider: "gemini",
      defaultModel: "gemini-2.5-flash-image",
      requiredEnv: ["GEMINI_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "gemini",
        "generate",
        ...opt("prompt", prompt),
        ...modelFlag(model, "gemini-2.5-flash-image"),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        ...opt("size", params.size && /K$/.test(params.size) ? params.size : undefined),
        "--image-format=original",
        ...out(output),
      ],
    },
    {
      provider: "openai",
      defaultModel: "gpt-image-2",
      requiredEnv: ["OPENAI_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "openai",
        "generate",
        "--driver=api",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("size", params.size && /x|auto/.test(params.size) ? params.size : "1536x1024"),
        ...opt("quality", params.quality ?? "medium"),
        "--image-format=original",
        ...out(output),
      ],
    },
    {
      provider: "openrouter",
      defaultModel: "google/gemini-3.1-flash-image-preview",
      requiredEnv: ["OPENROUTER_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "openrouter",
        "generate",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        "--image-format=original",
        ...out(output),
      ],
    },
    {
      provider: "minimax",
      defaultModel: "image-01",
      requiredEnv: ["MINIMAX_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "minimax",
        "generate",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        "--image-format=original",
        ...out(output),
      ],
    },
    {
      provider: "fal",
      defaultModel: "fal-ai/flux/schnell",
      requiredEnv: ["FAL_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "fal",
        "image",
        ...opt("model", model),
        ...opt("image-size", params.aspectRatio === "9:16" ? "portrait_16_9" : "landscape_16_9"),
        "--image-format=original",
        ...out(output),
        ...positional(prompt),
      ],
    },
    {
      provider: "cloudflare",
      defaultModel: "@cf/black-forest-labs/flux-1-schnell",
      requiredEnv: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, output }) => [
        "cloudflare",
        "generate",
        ...opt("prompt", prompt),
        "--image-format=original",
        ...out(output),
      ],
    },
    {
      provider: "leonardo",
      defaultModel: "leonardo-default",
      requiredEnv: ["LEONARDO_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, output, model }) => [
        "leonardo",
        "generate",
        ...modelFlag(model, "leonardo-default"),
        "--image-format=original",
        ...out(output),
        ...positional(prompt),
      ],
    },
  ],
  "image.edit": [
    {
      provider: "gemini",
      defaultModel: "gemini-2.5-flash-image",
      requiredEnv: ["GEMINI_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "gemini",
        "i2i",
        ...opt("prompt", prompt),
        ...opt("ref", need(params.inputImage, "inputImage", "gemini")),
        ...opt("model", model),
        "--image-format=original",
        ...out(output),
      ],
    },
    {
      provider: "openai",
      defaultModel: "gpt-image-2",
      requiredEnv: ["OPENAI_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "openai",
        "i2i",
        "--driver=api",
        ...opt("prompt", prompt),
        ...opt("ref", need(params.inputImage, "inputImage", "openai")),
        ...opt("model", model),
        ...opt("quality", params.quality ?? "medium"),
        "--image-format=original",
        ...out(output),
      ],
    },
    {
      provider: "openrouter",
      defaultModel: "google/gemini-2.5-flash-image",
      requiredEnv: ["OPENROUTER_API_KEY"],
      ext: "png",
      unit: "image",
      buildArgv: ({ prompt, params, output, model }) => [
        "openrouter",
        "i2i",
        ...opt("prompt", prompt),
        ...opt("ref", need(params.inputImage, "inputImage", "openrouter")),
        ...opt("model", model),
        "--image-format=original",
        ...out(output),
      ],
    },
  ],
  "image.upscale": [
    {
      provider: "fal",
      defaultModel: "fal-ai/clarity-upscaler",
      requiredEnv: ["FAL_KEY"],
      ext: "png",
      unit: "generation",
      buildArgv: ({ params, model }) => [
        "fal",
        "run",
        ...opt("input", JSON.stringify({ image_url: needUrl(params.inputImage, "inputImage", "fal") })),
        ...positional(model),
      ],
    },
  ],
  "video.t2v": [
    {
      provider: "gemini",
      defaultModel: "veo-3.1-fast-generate-preview",
      requiredEnv: ["GEMINI_API_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 8,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, output, model }) => [
        "gemini",
        "generate-video",
        ...opt("prompt", prompt),
        ...modelFlag(model, "veo-3.1-fast-generate-preview"),
        ...opt("resolution", params.resolution ?? "1080p"),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        "--no-thumb",
        ...out(output),
      ],
    },
    {
      provider: "minimax",
      defaultModel: "MiniMax-Hailuo-2.3",
      requiredEnv: ["MINIMAX_API_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 6,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, output, model }) => [
        "minimax",
        "generate-video",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("duration", minimaxDuration(params.durationSeconds)),
        ...opt("resolution", minimaxResolution(params.resolution)),
        "--no-thumb",
        ...out(output),
      ],
    },
    {
      provider: "byteplus",
      defaultModel: "seedance-2.0",
      requiredEnv: ["BYTEPLUS_API_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 8,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, output, model }) => [
        "byteplus",
        "video",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("resolution", params.resolution ?? "1080p"),
        ...opt("duration", Math.min(15, Math.max(4, Math.round(params.durationSeconds ?? 8)))),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        "--no-audio",
        "--no-thumb",
        ...out(output),
      ],
    },
    {
      provider: "fal",
      defaultModel: "fal-ai/kling-video/v1.6/standard/text-to-video",
      requiredEnv: ["FAL_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 5,
      timeoutMs: VIDEO_TIMEOUT_MS,
      // `fal video` has no --output; the file lands in MULTIX_OUTPUT_DIR and is parsed from stdout.
      buildArgv: ({ prompt, params, model }) => [
        "fal",
        "video",
        ...opt("model", model),
        ...opt(
          "duration",
          params.durationSeconds !== undefined ? Math.round(params.durationSeconds) : undefined,
        ),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        ...positional(prompt),
      ],
    },
  ],
  "video.i2v": [
    {
      provider: "gemini",
      defaultModel: "veo-3.1-fast-generate-preview",
      requiredEnv: ["GEMINI_API_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 8,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, output, model }) => [
        "gemini",
        "i2v",
        ...opt("prompt", prompt),
        ...modelFlag(model, "veo-3.1-fast-generate-preview"),
        ...opt("resolution", params.resolution ?? "1080p"),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        "--no-thumb",
        ...out(output),
        ...positional(need(params.inputImage, "inputImage", "gemini")),
      ],
    },
    {
      provider: "byteplus",
      defaultModel: "seedance-2.0",
      requiredEnv: ["BYTEPLUS_API_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 8,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, output, model }) => [
        "byteplus",
        "i2v",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("resolution", params.resolution ?? "1080p"),
        ...opt("duration", Math.min(15, Math.max(4, Math.round(params.durationSeconds ?? 8)))),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        "--no-audio",
        "--no-thumb",
        ...out(output),
        ...positional(need(params.inputImage, "inputImage", "byteplus")),
      ],
    },
    {
      provider: "minimax",
      defaultModel: "MiniMax-Hailuo-2.3",
      requiredEnv: ["MINIMAX_API_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 6,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, output, model }) => [
        "minimax",
        "generate-video",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("first-frame", needUrl(params.inputImage, "inputImage", "minimax")),
        ...opt("duration", minimaxDuration(params.durationSeconds)),
        ...opt("resolution", minimaxResolution(params.resolution)),
        "--no-thumb",
        ...out(output),
      ],
    },
    {
      provider: "fal",
      defaultModel: "fal-ai/kling-video/v1.6/standard/image-to-video",
      requiredEnv: ["FAL_KEY"],
      ext: "mp4",
      unit: "video_second",
      defaultQuantity: 5,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, model }) => [
        "fal",
        "video",
        ...opt("model", model),
        ...opt("image-url", needUrl(params.inputImage, "inputImage", "fal")),
        ...opt(
          "duration",
          params.durationSeconds !== undefined ? Math.round(params.durationSeconds) : undefined,
        ),
        ...opt("aspect-ratio", params.aspectRatio ?? "16:9"),
        ...positional(prompt),
      ],
    },
  ],
  "audio.tts": [
    {
      provider: "openai",
      defaultModel: "gpt-4o-mini-tts",
      requiredEnv: ["OPENAI_API_KEY"],
      ext: "mp3",
      unit: "kchar",
      buildArgv: ({ prompt, params, output, model }) => [
        "openai",
        "generate-speech",
        ...opt("text", prompt),
        ...opt("model", model),
        ...opt("voice", params.voice),
        "--output-format=mp3",
        ...out(output),
      ],
    },
    {
      provider: "elevenlabs",
      defaultModel: "eleven_multilingual_v2",
      requiredEnv: ["ELEVENLABS_API_KEY"],
      ext: "mp3",
      unit: "kchar",
      buildArgv: ({ prompt, params, output, model }) => [
        "elevenlabs",
        "tts",
        ...opt("text", prompt),
        ...opt("model", model),
        ...opt("voice", params.voice),
        ...opt("language-code", params.language),
        ...out(output),
      ],
    },
    {
      provider: "gemini",
      defaultModel: "gemini-3.8-flash-tts",
      requiredEnv: ["GEMINI_API_KEY"],
      ext: "wav",
      unit: "kchar",
      buildArgv: ({ prompt, params, output, model }) => [
        "gemini",
        "generate-speech",
        ...opt("text", prompt),
        ...opt("model", model),
        ...opt("voice", params.voice),
        "--output-format=wav",
        ...out(output),
      ],
    },
    {
      provider: "minimax",
      defaultModel: "speech-2.8-turbo",
      requiredEnv: ["MINIMAX_API_KEY"],
      ext: "mp3",
      unit: "kchar",
      buildArgv: ({ prompt, params, output, model }) => [
        "minimax",
        "generate-speech",
        ...opt("text", prompt),
        ...opt("model", model),
        ...opt("voice", params.voice),
        "--output-format=mp3",
        ...out(output),
      ],
    },
  ],
  "audio.stt": [
    {
      provider: "openai",
      defaultModel: "gpt-4o-transcribe",
      requiredEnv: ["OPENAI_API_KEY"],
      ext: "txt",
      unit: "audio_minute",
      defaultQuantity: 1,
      buildArgv: ({ params, output, model }) => [
        "openai",
        "transcribe",
        ...opt("input", need(params.inputFile, "inputFile", "openai")),
        ...opt("model", model),
        "--format=text",
        ...opt("language", params.language),
        ...out(output),
      ],
    },
    {
      provider: "elevenlabs",
      defaultModel: "scribe_v1",
      requiredEnv: ["ELEVENLABS_API_KEY"],
      ext: "txt",
      unit: "audio_minute",
      defaultQuantity: 1,
      buildArgv: ({ params, output, model }) => [
        "elevenlabs",
        "transcribe",
        ...opt("input", need(params.inputFile, "inputFile", "elevenlabs")),
        ...opt("model", model),
        "--format=text",
        ...opt("language", params.language),
        ...out(output),
      ],
    },
    {
      provider: "gemini",
      defaultModel: "gemini-2.5-flash",
      requiredEnv: ["GEMINI_API_KEY"],
      ext: "txt",
      unit: "audio_minute",
      defaultQuantity: 1,
      buildArgv: ({ params, output, model }) => [
        "gemini",
        "transcribe",
        ...opt("files", need(params.inputFile, "inputFile", "gemini")),
        ...opt("model", model),
        "--format=text",
        ...out(output),
      ],
    },
  ],
  "audio.music": [
    {
      provider: "elevenlabs",
      defaultModel: "music_v1",
      requiredEnv: ["ELEVENLABS_API_KEY"],
      ext: "mp3",
      unit: "audio_second",
      defaultQuantity: 30,
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, params, output, model }) => [
        "elevenlabs",
        "music",
        ...opt("prompt", prompt),
        ...opt("model", model),
        ...opt("music-length-ms", Math.round((params.durationSeconds ?? 30) * 1000)),
        ...out(output),
      ],
    },
    {
      provider: "minimax",
      defaultModel: "music-2.5",
      requiredEnv: ["MINIMAX_API_KEY"],
      ext: "mp3",
      unit: "generation",
      timeoutMs: VIDEO_TIMEOUT_MS,
      buildArgv: ({ prompt, output, model }) => [
        "minimax",
        "generate-music",
        ...opt("prompt", prompt),
        ...opt("model", model),
        "--output-format=mp3",
        ...out(output),
      ],
    },
  ],
  "audio.sfx": [
    {
      provider: "elevenlabs",
      defaultModel: "sound-effects",
      requiredEnv: ["ELEVENLABS_API_KEY"],
      ext: "mp3",
      unit: "generation",
      buildArgv: ({ prompt, params, output }) => [
        "elevenlabs",
        "sfx",
        ...opt("text", prompt),
        ...opt(
          "duration-seconds",
          params.durationSeconds !== undefined
            ? Math.min(30, Math.max(0.5, params.durationSeconds))
            : undefined,
        ),
        ...out(output),
      ],
    },
  ],
};

/** Every environment variable a multix route can need, with the providers that use it (sorted by name). */
export function multixEnvKeys(): { name: string; providers: MediaProvider[] }[] {
  const byName = new Map<string, Set<MediaProvider>>();
  for (const routes of Object.values(CAPABILITY_MATRIX)) {
    for (const route of routes) {
      for (const name of route.requiredEnv) {
        const set = byName.get(name) ?? new Set<MediaProvider>();
        set.add(route.provider);
        byName.set(name, set);
      }
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, providers]) => ({ name, providers: [...providers].sort() }));
}
