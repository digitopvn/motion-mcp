import Anthropic from "@anthropic-ai/sdk";
import type { ModelUsage } from "@motion-mcp/observability";
import { AUTH_REJECTED, MotionError, redact, registerSecret } from "@motion-mcp/shared";
import { estimateCost } from "./prices.ts";
import { type ChatOptions, type ChatResult, chat } from "./structured-chat.ts";
import type { ChatMessage, Completion, CompletionRequest, ModelGateway } from "./types.ts";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** The slice of the official SDK client this gateway uses; tests inject a fake. */
export interface AnthropicSdkClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
  models: { list(params?: { limit?: number }, options?: { signal?: AbortSignal }): PromiseLike<unknown> };
}

export interface AnthropicClientOptions {
  apiKey: string;
  /** SDK retries for 408/409/429/5xx and connection errors. */
  maxRetries?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Test seam: replaces the official SDK client. */
  client?: AnthropicSdkClient;
}

/**
 * Direct Anthropic Messages API gateway over the official `@anthropic-ai/sdk`. Implements `ModelGateway`
 * for the Director and Critic when a workspace stores its own Anthropic API key.
 *
 * The key is always passed explicitly and the base URL is pinned, so an ambient `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` on the server never changes who pays for a call.
 */
export class AnthropicClient implements ModelGateway {
  private readonly client: AnthropicSdkClient;

  constructor(options: AnthropicClientOptions) {
    if (!options.apiKey) throw new MotionError("CONFIG", "Anthropic API key is not set");
    registerSecret(options.apiKey);
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        authToken: null,
        baseURL: ANTHROPIC_BASE_URL,
        maxRetries: options.maxRetries ?? 3,
        timeout: options.timeoutMs ?? 180_000,
      });
  }

  /** Chat with optional zod-validated structured output and one bounded repair retry. */
  chat<T = unknown>(options: ChatOptions<T>): Promise<ChatResult<T>> {
    return chat(this, options);
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (request.signal?.aborted) throw new MotionError("CANCELLED", "model call cancelled");
    const body = buildAnthropicRequest(request);
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(body, { signal: request.signal });
    } catch (err) {
      throw toAnthropicError(err, request.model, request.signal);
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (message.stop_reason === "refusal") {
      throw new MotionError("PROVIDER", "Anthropic model refused the request", {
        details: { model: request.model, reason: "refusal" },
      });
    }
    return {
      text,
      finishReason: message.stop_reason ?? undefined,
      usage: toModelUsage(message.model || request.model, message.usage),
    };
  }

  /**
   * Check that the key authenticates without spending tokens (`GET /v1/models` is free).
   * Throws `MotionError("PROVIDER")` with `details.reason === AUTH_REJECTED` for a rejected key,
   * and `PROVIDER`/`TIMEOUT` for transport problems.
   */
  async verifyKey(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.models.list({ limit: 1 }, { signal });
    } catch (err) {
      throw toAnthropicError(err, "models.list", signal);
    }
  }
}

/** Translate a provider-neutral request into a Messages API body. */
export function buildAnthropicRequest(request: CompletionRequest): Anthropic.MessageCreateParamsNonStreaming {
  const system: Anthropic.TextBlockParam[] = [];
  const messages: Anthropic.MessageParam[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      for (const part of toBlocks(message)) {
        if (part.type !== "text") throw new MotionError("VALIDATION", "system messages must be text");
        system.push(part);
      }
      continue;
    }
    const blocks = toBlocks(message);
    const previous = messages.at(-1);
    // The Messages API requires alternating roles; merge consecutive turns from the same speaker.
    if (previous && previous.role === message.role && Array.isArray(previous.content)) {
      previous.content.push(...(blocks as Anthropic.ContentBlockParam[]));
    } else {
      messages.push({ role: message.role, content: blocks as Anthropic.ContentBlockParam[] });
    }
  }
  if (request.cache) {
    const last = system.at(-1);
    if (last) last.cache_control = { type: "ephemeral" };
  }
  // `temperature`/`top_p`/`top_k` are rejected by current Claude models, so a requested temperature is
  // deliberately not forwarded; prompts carry the creative direction instead.
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: request.model,
    max_tokens: request.maxTokens,
    messages,
  };
  if (system.length > 0) body.system = system;
  if (request.jsonSchema) {
    body.output_config = { format: { type: "json_schema", schema: request.jsonSchema.schema } };
  }
  return body;
}

function toBlocks(message: ChatMessage): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content.map((part) => {
    if (part.type === "text") {
      return part.cache
        ? { type: "text", text: part.text, cache_control: { type: "ephemeral" } }
        : { type: "text", text: part.text };
    }
    return { type: "image", source: toImageSource(part.url) };
  });
}

function toImageSource(url: string): Anthropic.Base64ImageSource | Anthropic.URLImageSource {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(url);
  if (match) {
    const mediaType = match[1]?.toLowerCase() as ImageMediaType;
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
      throw new MotionError("VALIDATION", `unsupported image type for Anthropic: ${mediaType}`);
    }
    return { type: "base64", media_type: mediaType, data: match[2] ?? "" };
  }
  if (url.startsWith("https://")) return { type: "url", url };
  throw new MotionError("VALIDATION", "image inputs must be data:image URLs or https URLs");
}

function toModelUsage(model: string, usage: Anthropic.Usage): ModelUsage {
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  // Anthropic reports uncached input separately; `ModelUsage.inputTokens` is the total prompt size.
  const inputTokens = usage.input_tokens + cacheReadTokens + cacheWriteTokens;
  const outputTokens = usage.output_tokens;
  return {
    model,
    provider: "anthropic",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: estimateCost(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) ?? 0,
  };
}

/** Map SDK errors onto `MotionError` codes; messages are redacted and never include the key. */
export function toAnthropicError(err: unknown, model: string, signal?: AbortSignal): MotionError {
  if (err instanceof MotionError) return err;
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) {
    return new MotionError("CANCELLED", "model call cancelled", { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new MotionError("TIMEOUT", "Anthropic request timed out", {
      retryable: true,
      details: { model },
    });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new MotionError("PROVIDER", `Anthropic rejected the API key (HTTP ${err.status})`, {
      details: { model, status: err.status, reason: AUTH_REJECTED },
    });
  }
  // A valid key without access to this model or resource: not a revoked key.
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new MotionError(
      "PROVIDER",
      redact(`Anthropic denied the request (HTTP 403): ${err.message}`).slice(0, 400),
      {
        details: { model, status: err.status, reason: "permission_denied" },
      },
    );
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    const retryable = status === 408 || status === 429 || status >= 500 || status === 0;
    return new MotionError("PROVIDER", redact(`Anthropic HTTP ${status}: ${err.message}`).slice(0, 400), {
      retryable,
      details: { model, status },
    });
  }
  return new MotionError(
    "PROVIDER",
    `Anthropic request failed: ${redact(err instanceof Error ? err.message : String(err))}`,
    { retryable: true, details: { model } },
  );
}
