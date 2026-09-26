import type { ModelUsage } from "@motion-mcp/observability";

/** Text block. `cache: true` marks an explicit prompt-cache breakpoint after this block (Anthropic models). */
export interface TextPart {
  type: "text";
  text: string;
  cache?: boolean;
}

/** Image input for vision models. `url` must be a `data:image/...` URL or an https URL. */
export interface ImagePart {
  type: "image";
  url: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** One raw provider call. Gateways do transport, retries and usage accounting; nothing else. */
export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** JSON Schema for structured output (already converted from zod). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Mark the stable system prompt as an ephemeral cache breakpoint (applied to Anthropic models only). */
  cache?: boolean;
  signal?: AbortSignal;
}

export interface Completion {
  text: string;
  finishReason?: string;
  usage: ModelUsage;
}

/**
 * Transport seam between callers (director, decision client) and a model provider.
 * Production uses `OpenRouterClient`; tests inject a scripted gateway that replays fixtures.
 */
export interface ModelGateway {
  complete(request: CompletionRequest): Promise<Completion>;
}
