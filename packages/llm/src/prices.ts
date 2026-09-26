/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Fallback price table for the default models, used only when OpenRouter does not return `usage.cost`.
 * Source: public `openrouter.ai/api/v1/models` endpoint, fetched 2026-09-26. Prices drift; the API
 * cost always wins when present.
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "anthropic/claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "deepseek/deepseek-v4-flash": { input: 0.04704, output: 0.09408, cacheRead: 0.009408 },
  "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.0833 },
  "z-ai/glm-5.3-flash": { input: 0.04, output: 0.5, cacheRead: 0.015 },
  "qwen/qwen3.8-flash": { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
};

export interface TokenCounts {
  /** Total prompt tokens, including cache reads and writes (OpenRouter `prompt_tokens`). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function priceFor(model: string): ModelPrice | undefined {
  // Variant suffixes such as `:nitro` keep base pricing in the fallback table.
  return PRICES[model] ?? PRICES[model.split(":")[0] ?? model];
}

/** Estimated USD cost, or `undefined` when the model is not in the fallback table. */
export function estimateCost(model: string, usage: TokenCounts): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const usd =
    uncached * price.input +
    cacheRead * (price.cacheRead ?? price.input) +
    cacheWrite * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output;
  return usd / 1_000_000;
}
