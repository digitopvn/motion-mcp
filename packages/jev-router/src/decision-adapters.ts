import { chat, type ModelGateway } from "@motion-mcp/llm";
import type { ModelUsage, Span } from "@motion-mcp/observability";
import { MotionError, redact, redactDeep, registerSecret } from "@motion-mcp/shared";
import { z } from "zod";
import { clamp01, DecisionChain } from "./decision-chain.ts";
import type {
  AdapterAnswer,
  AnswerOf,
  Decision,
  DecisionAdapter,
  DecisionClient,
  DecisionQuestion,
  DecisionState,
} from "./decision-types.ts";

/** TypeSafe Jev pricing: $0.042 per 1M input tokens, output free. */
export const TYPESAFE_INPUT_USD_PER_M = 0.042;
/** Jev accepts 32k tokens of state; keep a conservative character budget. */
const MAX_STATE_CHARS = 24_000;

export function serializeState(state: DecisionState): string {
  const text = JSON.stringify(redactDeep(state));
  return text.length > MAX_STATE_CHARS ? `${text.slice(0, MAX_STATE_CHARS)}…` : text;
}

/** Shared `decide` for adapters used on their own (no fallback chain). */
abstract class StandaloneAdapter implements DecisionAdapter, DecisionClient {
  abstract readonly name: DecisionAdapter["name"];
  abstract answer(question: DecisionQuestion, span: Span, signal: AbortSignal): Promise<AdapterAnswer>;

  decide<Q extends DecisionQuestion>(question: Q, span: Span): Promise<Decision<AnswerOf<Q>>> {
    return new DecisionChain([this]).decide(question, span);
  }
}

/** Deterministic adapter: evaluates the question's own rule. Always answers; the CI path. */
export class RuleDecisionClient extends StandaloneAdapter {
  readonly name = "rules" as const;

  async answer(question: DecisionQuestion): Promise<AdapterAnswer> {
    if (question.kind === "choice") return { value: question.rule(question.state), confidence: 1 };
    const p = clamp01(question.rule(question.state));
    return { value: p, confidence: question.kind === "yesno" ? Math.abs(p - 0.5) * 2 : 1 };
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TypeSafeJevClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** `jev-latest`, `jev-preview` or a pinned version such as `jev-1.13.0`. */
  model?: string;
  fetch?: FetchLike;
}

const TypeSafeAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }).loose(),
  z
    .object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: z.record(z.string(), z.number()).optional(),
      confidence: z.number().optional(),
    })
    .loose(),
  z
    .object({
      type: z.literal("score"),
      score: z.number(),
      probabilities: z.record(z.string(), z.number()).optional(),
      confidence: z.number().optional(),
    })
    .loose(),
]);

const TypeSafeResponse = z
  .object({
    model: z.string().optional(),
    answers: z.record(z.string(), TypeSafeAnswer),
    usage: z.object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) }).optional(),
  })
  .loose();

/**
 * TypeSafe "System One" decision API (`POST /v1/systemone` with `{ model, state, questions }`).
 * Question mapping: choice → `choice` with `criteria` {key: description}; yesno → `noul`; score → `score`
 * with ordered `criteria` levels (the returned level position is normalized to 0–1).
 */
export class TypeSafeJevClient extends StandaloneAdapter {
  readonly name = "typesafe" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: TypeSafeJevClientOptions) {
    super();
    if (!options.apiKey) throw new MotionError("CONFIG", "TYPESAFE_API_KEY is not set");
    registerSecret(options.apiKey);
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
    this.model = options.model ?? "jev-latest";
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Request body for one question (exposed for contract tests). */
  buildRequest(question: DecisionQuestion): {
    model: string;
    state: string;
    questions: Record<string, unknown>;
  } {
    return {
      model: this.model,
      state: serializeState(question.state),
      questions: { [question.id]: toWire(question) },
    };
  }

  async answer(question: DecisionQuestion, span: Span, signal: AbortSignal): Promise<AdapterAnswer> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(this.buildRequest(question)),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new MotionError("PROVIDER", `TypeSafe HTTP ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500,
        details: { status: res.status, body: redact(text.slice(0, 300)) },
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MotionError("PROVIDER", "TypeSafe returned a non-JSON body");
    }
    const parsed = TypeSafeResponse.safeParse(json);
    if (!parsed.success) throw new MotionError("PROVIDER", "TypeSafe returned an unexpected response shape");
    const answer = parsed.data.answers[question.id];
    if (!answer) throw new MotionError("PROVIDER", `TypeSafe returned no answer for ${question.id}`);

    const model = parsed.data.model ?? this.model;
    const inputTokens = parsed.data.usage?.input_tokens ?? 0;
    const usage: ModelUsage = {
      model,
      provider: "typesafe",
      inputTokens,
      outputTokens: parsed.data.usage?.output_tokens ?? 0,
      costUsd: (inputTokens * TYPESAFE_INPUT_USD_PER_M) / 1_000_000,
    };
    span.recordModelCall(usage);

    if (question.kind === "choice" && answer.type === "choice") {
      return {
        value: answer.choice,
        confidence: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0.5,
        probabilities: answer.probabilities,
        model,
        usage,
      };
    }
    if (question.kind === "yesno" && answer.type === "noul") {
      return { value: answer.noul, confidence: Math.abs(answer.noul - 0.5) * 2, model, usage };
    }
    if (question.kind === "score" && answer.type === "score") {
      return {
        value: answer.score / (question.levels.length - 1),
        confidence: answer.confidence ?? 0.5,
        probabilities: answer.probabilities,
        model,
        usage,
      };
    }
    throw new MotionError("PROVIDER", `TypeSafe answer type ${answer.type} does not match ${question.kind}`);
  }
}

function toWire(question: DecisionQuestion): Record<string, unknown> {
  switch (question.kind) {
    case "choice":
      return { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
    case "yesno": {
      const criteria: Record<string, string> = {};
      if (question.criteria?.yes) criteria.true = question.criteria.yes;
      if (question.criteria?.no) criteria.false = question.criteria.no;
      return Object.keys(criteria).length
        ? { type: "noul", instructions: question.instructions, criteria }
        : { type: "noul", instructions: question.instructions };
    }
    case "score":
      return { type: "score", instructions: question.instructions, criteria: [...question.levels] };
  }
}

export interface LlmDecisionClientOptions {
  gateway: ModelGateway;
  /** Cheap structured-output model (DECISION_MODEL). */
  model: string;
  maxTokens?: number;
}

const LLM_DECISION_SYSTEM = [
  "You are a routing decision function inside a motion-video production pipeline.",
  "Read the state, answer the question using only the allowed values, and give calibrated probabilities.",
  "Reply with one JSON object and nothing else.",
].join(" ");

/** Decision adapter backed by a cheap OpenRouter model with a json_schema answer. */
export class LlmDecisionClient extends StandaloneAdapter {
  readonly name = "llm" as const;
  private readonly options: LlmDecisionClientOptions;

  constructor(options: LlmDecisionClientOptions) {
    super();
    if (options.model === "typesafe/jev-router") {
      throw new MotionError(
        "CONFIG",
        "typesafe/jev-router is a chat router without structured outputs; it cannot be a decision model",
      );
    }
    this.options = options;
  }

  async answer(question: DecisionQuestion, span: Span, signal: AbortSignal): Promise<AdapterAnswer> {
    const { schema, describe } = llmSchemaFor(question);
    const result = await chat(this.options.gateway, {
      model: this.options.model,
      messages: [
        { role: "system", content: LLM_DECISION_SYSTEM },
        {
          role: "user",
          content: `State:\n${serializeState(question.state)}\n\nQuestion (${question.id}): ${question.instructions}\n${describe}`,
        },
      ],
      responseSchema: { name: `decision_${question.kind}`, schema },
      maxTokens: this.options.maxTokens ?? 300,
      temperature: 0,
      signal,
      span,
    });
    const out = result.parsed as {
      choice?: string;
      probability?: number;
      level?: number;
      confidence?: number;
    };
    const base = { model: this.options.model, usage: result.usage };
    if (question.kind === "choice")
      return { ...base, value: out.choice ?? "", confidence: out.confidence ?? 0.5 };
    if (question.kind === "yesno") {
      const p = out.probability ?? 0.5;
      return { ...base, value: p, confidence: Math.abs(p - 0.5) * 2 };
    }
    return {
      ...base,
      value: (out.level ?? 0) / (question.levels.length - 1),
      confidence: out.confidence ?? 0.5,
    };
  }
}

function llmSchemaFor(question: DecisionQuestion): { schema: z.ZodType; describe: string } {
  const confidence = z.number().min(0).max(1);
  switch (question.kind) {
    case "choice": {
      const keys = Object.keys(question.options) as [string, ...string[]];
      return {
        schema: z.object({ choice: z.enum(keys), confidence }),
        describe: `Options:\n${keys.map((k) => `- ${k}: ${question.options[k]}`).join("\n")}\nReturn {"choice": <option>, "confidence": 0-1}.`,
      };
    }
    case "yesno":
      return {
        schema: z.object({ probability: z.number().min(0).max(1) }),
        describe: `${question.criteria?.yes ? `Yes means: ${question.criteria.yes}\n` : ""}${question.criteria?.no ? `No means: ${question.criteria.no}\n` : ""}Return {"probability": 0-1} for yes.`,
      };
    case "score":
      return {
        schema: z.object({
          level: z
            .number()
            .min(0)
            .max(question.levels.length - 1),
          confidence,
        }),
        describe: `Levels:\n${question.levels.map((l, i) => `${i}: ${l}`).join("\n")}\nReturn {"level": 0-${question.levels.length - 1} (fractions allowed), "confidence": 0-1}.`,
      };
  }
}
