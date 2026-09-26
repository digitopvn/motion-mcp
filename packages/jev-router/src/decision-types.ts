import type { ModelUsage, Span } from "@motion-mcp/observability";

/**
 * Compact, JSON-serializable summary of what a decision is about (issue, scene role, attempts,
 * budget, mode). Never contains secrets or full HTML; adapters redact it again before sending.
 */
export type DecisionState = Record<string, unknown>;

interface QuestionBase {
  /** Stable snake_case question name (`root_cause`, `cheap_fixable`, ...). */
  id: string;
  instructions: string;
  state: DecisionState;
}

/** Pick one option key. `options` maps each key to its description. */
export interface ChoiceQuestion<T extends string = string> extends QuestionBase {
  kind: "choice";
  options: Record<T, string>;
  /** Deterministic answer used by the rules adapter. */
  rule: (state: DecisionState) => T;
}

/** Probability (0–1) that the answer is yes. */
export interface YesNoQuestion extends QuestionBase {
  kind: "yesno";
  criteria?: { yes?: string; no?: string };
  rule: (state: DecisionState) => number;
}

/** Position on an ordered scale of `levels`, normalized to 0–1. */
export interface ScoreQuestion extends QuestionBase {
  kind: "score";
  levels: string[];
  rule: (state: DecisionState) => number;
}

export type DecisionQuestion = ChoiceQuestion | YesNoQuestion | ScoreQuestion;

/** Answer type for a question: the option key for choices, a 0–1 number otherwise. */
export type AnswerOf<Q> = Q extends ChoiceQuestion<infer T> ? T : number;

export type AdapterName = "typesafe" | "llm" | "rules";

export interface Decision<T> {
  questionId: string;
  kind: DecisionQuestion["kind"];
  value: T;
  /** 0–1 certainty of the answer as reported (or derived) by the adapter. */
  confidence: number;
  probabilities?: Record<string, number>;
  adapter: AdapterName;
  model?: string;
  latencyMs: number;
  usage?: ModelUsage;
  /** Adapters tried before the one that answered, with the reason each fell through. */
  fallbacks: Array<{ adapter: AdapterName; reason: string }>;
}

/** Raw adapter output before chain validation. `value` is a choice key or a 0–1 number. */
export interface AdapterAnswer {
  value: string | number;
  confidence: number;
  probabilities?: Record<string, number>;
  model?: string;
  usage?: ModelUsage;
}

export interface DecisionAdapter {
  readonly name: AdapterName;
  answer(question: DecisionQuestion, span: Span, signal: AbortSignal): Promise<AdapterAnswer>;
}

export interface DecisionClient {
  decide<Q extends DecisionQuestion>(question: Q, span: Span): Promise<Decision<AnswerOf<Q>>>;
}
