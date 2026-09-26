import type { ModelUsage, Span } from "@motion-mcp/observability";
import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";
import { toPortableJsonSchema } from "./portable-json-schema.ts";
import type { ChatMessage, Completion, ContentPart, ModelGateway, TextPart } from "./types.ts";

export interface ResponseSchema<T> {
  name: string;
  schema: z.ZodType<T>;
  /** JSON Schema sent to the provider. Defaults to `toResponseJsonSchema(schema)`. */
  jsonSchema?: Record<string, unknown>;
}

export interface ChatOptions<T = unknown> {
  model: string;
  messages: ChatMessage[];
  responseSchema?: ResponseSchema<T>;
  maxTokens: number;
  temperature?: number;
  /** Cache the stable system block (Anthropic models). */
  cache?: boolean;
  signal?: AbortSignal;
  /** Every provider call (including repairs) is recorded here with `recordModelCall`. */
  span?: Span;
  /** Repair attempts after an invalid structured response. Bounded to 0..2, default 1. */
  maxRepairs?: number;
  /**
   * How the schema reaches the model. `json_schema` uses `response_format`; `prompt` puts the schema in the
   * system prompt. `auto` (default) tries `json_schema` and falls back to `prompt` once when the provider
   * rejects the schema itself (for example Anthropic's grammar limits on optional fields).
   */
  schemaTransport?: "auto" | "json_schema" | "prompt";
}

export interface ChatResult<T = unknown> {
  text: string;
  parsed?: T;
  /** Aggregated usage across all calls made for this chat (initial plus repairs). */
  usage: ModelUsage;
  calls: ModelUsage[];
}

const MAX_ISSUE_CHARS = 2000;

/** Provider-portable JSON Schema for a zod response schema (no `$schema`, no unsupported keywords). */
export function toResponseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return toPortableJsonSchema(json);
}

/**
 * Run one chat through a gateway. With `responseSchema`, the reply is parsed and validated with zod;
 * on failure the validation issues are sent back for a bounded number of repairs, after which a typed
 * `MotionError("PROVIDER")` is thrown.
 */
export async function chat<T = unknown>(
  gateway: ModelGateway,
  options: ChatOptions<T>,
): Promise<ChatResult<T>> {
  const calls: ModelUsage[] = [];
  let messages = [...options.messages];
  const schemaJson = options.responseSchema
    ? (options.responseSchema.jsonSchema ?? toResponseJsonSchema(options.responseSchema.schema))
    : undefined;
  const maxRepairs = Math.min(2, Math.max(0, options.maxRepairs ?? 1));
  const requested = options.schemaTransport ?? "auto";
  let transport: "json_schema" | "prompt" =
    requested === "prompt" || (requested === "auto" && schemaRejectedModels.has(options.model))
      ? "prompt"
      : "json_schema";
  if (schemaJson && transport === "prompt") messages = withSchemaInstruction(messages, schemaJson);

  const call = async (): Promise<Completion> => {
    let completion: Completion;
    try {
      completion = await gateway.complete({
        model: options.model,
        messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        jsonSchema:
          schemaJson && options.responseSchema && transport === "json_schema"
            ? { name: options.responseSchema.name, schema: schemaJson }
            : undefined,
        cache: options.cache,
        signal: options.signal,
      });
    } catch (err) {
      if (!(schemaJson && requested === "auto" && transport === "json_schema" && isSchemaRejection(err)))
        throw err;
      // The provider cannot compile this schema into a grammar (e.g. too many optional fields): send the
      // schema in the (cached) system prompt instead and rely on zod validation plus repair.
      schemaRejectedModels.add(options.model);
      transport = "prompt";
      messages = withSchemaInstruction(messages, schemaJson);
      options.span?.setAttributes({ "llm.schema_fallback": true });
      return call();
    }
    calls.push(completion.usage);
    options.span?.recordModelCall(completion.usage);
    return completion;
  };

  let completion = await call();
  if (!options.responseSchema) return { text: completion.text, usage: sumUsage(calls), calls };

  for (let attempt = 0; ; attempt++) {
    const result = parseStructured(completion.text, options.responseSchema.schema);
    if (result.ok) return { text: completion.text, parsed: result.value, usage: sumUsage(calls), calls };
    if (attempt >= maxRepairs) {
      throw new MotionError(
        "PROVIDER",
        `Model returned invalid structured output for ${options.responseSchema.name}`,
        {
          details: {
            reason: "invalid_structured_output",
            model: options.model,
            attempts: attempt + 1,
            issues: result.issues,
            finishReason: completion.finishReason,
          },
        },
      );
    }
    options.span?.retry();
    messages.push(
      { role: "assistant", content: completion.text.slice(0, 8000) || "(empty)" },
      {
        role: "user",
        content:
          `Your previous reply did not match the required JSON schema "${options.responseSchema.name}".\n` +
          `Problems:\n${result.issues}\n` +
          "Reply again with only the corrected JSON object. No prose, no code fences.",
      },
    );
    completion = await call();
  }
}

/** Models whose provider rejected a json_schema in this process; `auto` goes straight to prompt transport. */
const schemaRejectedModels = new Set<string>();

function isSchemaRejection(err: unknown): boolean {
  return (
    err instanceof MotionError &&
    err.code === "PROVIDER" &&
    err.details?.status === 400 &&
    /schema|grammar|response_format|optional parameters/i.test(err.message)
  );
}

/** Append the JSON Schema as a final system text block so it stays inside the cached prefix. */
function withSchemaInstruction(messages: ChatMessage[], schema: Record<string, unknown>): ChatMessage[] {
  const instruction: TextPart = {
    type: "text",
    text:
      "Output format: reply with one JSON object that is valid against this JSON Schema. " +
      `No prose, no code fences.\n${JSON.stringify(schema)}`,
  };
  const [first, ...rest] = messages;
  if (first?.role === "system") {
    const parts: ContentPart[] =
      typeof first.content === "string" ? [{ type: "text", text: first.content }] : [...first.content];
    return [{ role: "system", content: [...parts, instruction] }, ...rest];
  }
  return [{ role: "system", content: [instruction] }, ...messages];
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string };

/** Parse model text as JSON (tolerating code fences and surrounding prose) and validate it. */
export function parseStructured<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  const candidate = extractJson(text);
  if (candidate === undefined) return { ok: false, issues: "Reply was not valid JSON." };
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: z.prettifyError(parsed.error).slice(0, MAX_ISSUE_CHARS) };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export function sumUsage(calls: ModelUsage[]): ModelUsage {
  const first = calls[0];
  const total: ModelUsage = {
    model: first?.model ?? "",
    provider: first?.provider ?? "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  for (const c of calls) {
    total.inputTokens += c.inputTokens;
    total.outputTokens += c.outputTokens;
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (c.cacheReadTokens ?? 0);
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (c.cacheWriteTokens ?? 0);
    total.costUsd += c.costUsd;
  }
  return total;
}
