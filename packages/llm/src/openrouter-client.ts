import type { ModelUsage } from "@motion-mcp/observability";
import { MotionError, redact, registerSecret } from "@motion-mcp/shared";
import { z } from "zod";
import { estimateCost } from "./prices.ts";
import { type ChatOptions, type ChatResult, chat } from "./structured-chat.ts";
import type { ChatMessage, Completion, CompletionRequest, ModelGateway } from "./types.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Retries after the first attempt for 408/429/5xx and network errors. */
  maxRetries?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Base backoff; attempt n waits `base * 2^n` plus jitter, or `Retry-After` when the provider sends it. */
  backoffMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Sent as `X-Title` for OpenRouter attribution. */
  appName?: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const MAX_BACKOFF_MS = 20_000;

const UsageSchema = z
  .object({
    prompt_tokens: z.number().default(0),
    completion_tokens: z.number().default(0),
    cost: z.number().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional() })
      .partial()
      .nullish(),
  })
  .loose();

const ResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().nullish(),
            message: z
              .object({
                content: z.union([z.string(), z.array(z.object({ text: z.string() }).loose())]).nullish(),
              })
              .loose(),
          })
          .loose(),
      )
      .default([]),
    usage: UsageSchema.optional(),
    error: z
      .object({ message: z.string().optional(), code: z.union([z.number(), z.string()]).optional() })
      .optional(),
  })
  .loose();

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** OpenRouter chat-completions client over native `fetch`. Implements `ModelGateway`. */
export class OpenRouterClient implements ModelGateway {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly appName: string;

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey) throw new MotionError("CONFIG", "OPENROUTER_API_KEY is not set");
    registerSecret(options.apiKey);
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.backoffMs = options.backoffMs ?? 500;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.appName = options.appName ?? "Motion MCP";
  }

  /** Chat with optional zod-validated structured output and one bounded repair retry. */
  chat<T = unknown>(options: ChatOptions<T>): Promise<ChatResult<T>> {
    return chat(this, options);
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const body = buildRequestBody(request);
    const payload = JSON.stringify(body);
    let lastError: MotionError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (request.signal?.aborted) throw new MotionError("CANCELLED", "model call cancelled");
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs);
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "X-Title": this.appName,
          },
          body: payload,
          signal,
        });
        const text = await res.text();
        if (!res.ok) {
          retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
          const reason = providerMessage(text);
          lastError = providerError(
            `OpenRouter HTTP ${res.status}${reason ? `: ${reason}` : ""}`,
            request.model,
            res.status,
            text,
          );
          if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
        } else {
          return this.parseResponse(text, request.model);
        }
      } catch (err) {
        if (request.signal?.aborted)
          throw new MotionError("CANCELLED", "model call cancelled", { cause: err });
        if (err instanceof MotionError) {
          if (!err.retryable) throw err;
          lastError = err;
        } else {
          const isTimeout =
            err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
          lastError = new MotionError(
            isTimeout ? "TIMEOUT" : "PROVIDER",
            `OpenRouter request failed: ${redact(err instanceof Error ? err.message : String(err))}`,
            { retryable: true, details: { model: request.model } },
          );
        }
      }
      if (attempt < this.maxRetries) {
        const backoff = Math.min(
          MAX_BACKOFF_MS,
          this.backoffMs * 2 ** attempt + Math.random() * this.backoffMs,
        );
        await this.sleep(retryAfterMs !== undefined ? Math.min(MAX_BACKOFF_MS, retryAfterMs) : backoff);
      }
    }
    throw (
      lastError ??
      new MotionError("PROVIDER", "OpenRouter request failed", { details: { model: request.model } })
    );
  }

  private parseResponse(text: string, requestedModel: string): Completion {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw providerError("OpenRouter returned a non-JSON body", requestedModel, 200, text, true);
    }
    const parsed = ResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw providerError("OpenRouter returned an unexpected response shape", requestedModel, 200, text);
    }
    const data = parsed.data;
    if (data.error) {
      const code = typeof data.error.code === "number" ? data.error.code : Number(data.error.code);
      const retryable = Number.isFinite(code) ? RETRYABLE_STATUS.has(code) : false;
      throw providerError(
        `OpenRouter error: ${data.error.message ?? "unknown"}`,
        requestedModel,
        code,
        "",
        retryable,
      );
    }
    const choice = data.choices[0];
    if (!choice) throw providerError("OpenRouter returned no choices", requestedModel, 200, text, true);
    const content = choice.message.content;
    const out = typeof content === "string" ? content : (content ?? []).map((p) => p.text).join("");
    const model = data.model ?? requestedModel;
    return {
      text: out,
      finishReason: choice.finish_reason ?? undefined,
      usage: toModelUsage(model, data.usage),
    };
  }
}

function toModelUsage(model: string, usage: z.infer<typeof UsageSchema> | undefined): ModelUsage {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const costUsd =
    usage?.cost ?? estimateCost(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) ?? 0;
  return {
    model,
    provider: "openrouter",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  };
}

function providerError(
  message: string,
  model: string,
  status: number,
  body: string,
  retryable = RETRYABLE_STATUS.has(status),
): MotionError {
  return new MotionError("PROVIDER", redact(message), {
    retryable,
    details: { model, status, body: redact(body.slice(0, 500)) },
  });
}

/** Provider error message from a JSON error body (`{ error: { message } }`), clipped. */
function providerMessage(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown; metadata?: { raw?: unknown } } };
    const raw = typeof json.error?.metadata?.raw === "string" ? ` (${json.error.metadata.raw})` : "";
    return typeof json.error?.message === "string" ? `${json.error.message}${raw}`.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

type WirePart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image_url"; image_url: { url: string } };

/** Translate a provider-neutral request into the OpenRouter chat-completions body. */
export function buildRequestBody(request: CompletionRequest): Record<string, unknown> {
  const anthropic = request.model.startsWith("anthropic/");
  const messages = request.messages.map((m) => toWireMessage(m, anthropic, request.cache === true));
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: request.maxTokens,
    usage: { include: true },
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: request.jsonSchema.name, strict: false, schema: request.jsonSchema.schema },
    };
    body.provider = { require_parameters: true };
  }
  return body;
}

function toWireMessage(message: ChatMessage, anthropic: boolean, cacheSystem: boolean) {
  const parts =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
  const wire: WirePart[] = parts.map((part) => {
    if (part.type === "image") {
      if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(part.url) && !part.url.startsWith("https://")) {
        throw new MotionError("VALIDATION", "image inputs must be data:image URLs or https URLs");
      }
      return { type: "image_url", image_url: { url: part.url } };
    }
    return anthropic && part.cache
      ? { type: "text", text: part.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: part.text };
  });
  if (anthropic && cacheSystem && message.role === "system") {
    const last = wire.findLast((p) => p.type === "text");
    if (last && last.type === "text") last.cache_control = { type: "ephemeral" };
  }
  const simple = wire.length === 1 && wire[0]?.type === "text" && !wire[0].cache_control;
  return { role: message.role, content: simple ? (wire[0] as { text: string }).text : wire };
}
