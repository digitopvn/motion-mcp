import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Runtime configuration. Model ids are configuration, never code, so operators can swap
 * frontier/cheap/decision models without a release.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1,app.motion.digitop.ai"),
  DATA_DIR: z.string().default(".data"),

  /** Comma-separated static API keys accepted by the MCP endpoint (hashed at rest in production). */
  MOTION_API_KEYS: z.string().default(""),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  DIRECTOR_MODEL: z.string().default("anthropic/claude-opus-5.5"),
  CODER_MODEL: z.string().default("deepseek/deepseek-v4-flash"),
  DECISION_MODEL: z.string().default("deepseek/deepseek-v4-flash"),
  VISION_MODEL: z.string().default("google/gemini-3.1-flash-lite"),

  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_BASE_URL: z.string().url().default("https://api.typesafe.ai"),
  JEV_MODEL: z.string().default("jev-latest"),

  DEFAULT_DIRECTOR_MODE: z.enum(["host-opus", "internal-opus", "custom"]).default("internal-opus"),
  IMPLEMENTATION_MODE: z.enum(["deterministic", "pi", "auto"]).default("auto"),
  MAX_REVISION_LOOPS: z.coerce.number().int().min(0).max(5).default(2),
  /** Jobs (compile + render) run in-process; renders are CPU/GPU bound, so the default is one at a time. */
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** Early-access trial credits granted once to a workspace the first time it is seen. 0 disables. */
  TRIAL_CREDITS: z.coerce.number().int().min(0).max(1_000_000).default(500),
  /**
   * HMAC secret for short-lived local artifact URLs. When unset it is derived from MOTION_API_KEYS; in
   * development a fixed value is used (with a warning).
   */
  ARTIFACT_SIGNING_SECRET: z.string().min(16).optional(),

  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().optional(),

  DATABASE_URL: z.string().optional(),

  POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),

  HYPERFRAMES_BIN: z.string().optional(),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  MULTIX_BIN: z.string().optional(),
});

export type MotionConfig = z.infer<typeof ConfigSchema>;

/** Minimal dotenv parser (no interpolation). Existing process env always wins. */
export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MotionConfig {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") cleaned[k] = v;
  return ConfigSchema.parse(cleaned);
}
