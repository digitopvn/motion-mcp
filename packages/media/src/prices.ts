/**
 * Indicative media prices in USD. multix reports no cost metadata, so Motion MCP estimates asset COGS from
 * the request it sends. Every value here is INDICATIVE (public list prices, rounded, September 2026) and
 * must be reconciled against provider invoices before it drives customer pricing.
 */

export type PriceUnit =
  /** One generated image. */
  | "image"
  /** One second of generated video. */
  | "video_second"
  /** 1,000 characters of synthesized speech. */
  | "kchar"
  /** One minute of transcribed audio. */
  | "audio_minute"
  /** One second of generated music. */
  | "audio_second"
  /** One generation call (flat). */
  | "generation";

export interface PriceEntry {
  provider: string;
  /** Exact model id, or `*` for the provider's default route price. */
  model: string;
  unit: PriceUnit;
  usd: number;
  indicative: true;
}

const p = (provider: string, model: string, unit: PriceUnit, usd: number): PriceEntry => ({
  provider,
  model,
  unit,
  usd,
  indicative: true,
});

export const PRICE_TABLE: readonly PriceEntry[] = [
  // Images
  p("gemini", "*", "image", 0.039),
  p("openai", "*", "image", 0.042),
  p("openai", "gpt-image-2", "image", 0.042),
  p("openrouter", "*", "image", 0.039),
  p("minimax", "*", "image", 0.0035),
  p("fal", "*", "image", 0.003),
  p("cloudflare", "*", "image", 0.0011),
  p("leonardo", "*", "image", 0.012),
  p("byteplus", "*", "image", 0.03),
  // Video (per generated second)
  p("gemini", "*", "video_second", 0.4),
  p("minimax", "*", "video_second", 0.08),
  p("byteplus", "*", "video_second", 0.1),
  p("fal", "*", "video_second", 0.045),
  // Speech synthesis (per 1k characters)
  p("openai", "*", "kchar", 0.015),
  p("elevenlabs", "*", "kchar", 0.1),
  p("gemini", "*", "kchar", 0.01),
  p("minimax", "*", "kchar", 0.1),
  // Transcription (per audio minute)
  p("openai", "*", "audio_minute", 0.006),
  p("elevenlabs", "*", "audio_minute", 0.0067),
  p("gemini", "*", "audio_minute", 0.002),
  // Music (per generated second) and flat generations
  p("elevenlabs", "*", "audio_second", 0.0135),
  p("minimax", "*", "generation", 0.15),
  p("elevenlabs", "*", "generation", 0.03),
  p("fal", "fal-ai/clarity-upscaler", "generation", 0.05),
];

export function findPrice(provider: string, model: string, unit: PriceUnit): PriceEntry | undefined {
  return (
    PRICE_TABLE.find((e) => e.provider === provider && e.model === model && e.unit === unit) ??
    PRICE_TABLE.find((e) => e.provider === provider && e.model === "*" && e.unit === unit)
  );
}

export interface AssetCostInput {
  provider: string;
  model: string;
  unit: PriceUnit;
  /** Units consumed (images, seconds, thousands of characters, minutes, generations). */
  quantity: number;
}

export interface AssetCostEstimate {
  usd: number;
  unit: PriceUnit;
  quantity: number;
  unitUsd: number;
  /** False when no table entry matched; `usd` is then 0 and the trace should flag the gap. */
  priced: boolean;
  indicative: true;
}

export function estimateAssetCost(input: AssetCostInput): AssetCostEstimate {
  const entry = findPrice(input.provider, input.model, input.unit);
  const quantity = Math.max(0, input.quantity);
  const unitUsd = entry?.usd ?? 0;
  return {
    usd: Math.round(unitUsd * quantity * 1e6) / 1e6,
    unit: input.unit,
    quantity,
    unitUsd,
    priced: entry !== undefined,
    indicative: true,
  };
}
