import type { Span } from "@motion-mcp/observability";
import { MotionError, redact } from "@motion-mcp/shared";
import type {
  AdapterAnswer,
  AnswerOf,
  Decision,
  DecisionAdapter,
  DecisionClient,
  DecisionQuestion,
} from "./decision-types.ts";

export interface DecisionChainOptions {
  /** Per-adapter timeout for network adapters; the rules adapter is never timed out. */
  timeoutMs?: number;
}

/**
 * Runs adapters in order until one returns a valid answer. Every decision is traced as a `jev.route`
 * span with the question, answer, adapter, fallbacks and latency; model calls are recorded on it.
 */
export class DecisionChain implements DecisionClient {
  readonly adapters: readonly DecisionAdapter[];
  private readonly timeoutMs: number;

  constructor(adapters: DecisionAdapter[], options: DecisionChainOptions = {}) {
    if (adapters.length === 0) throw new MotionError("CONFIG", "DecisionChain needs at least one adapter");
    this.adapters = adapters;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  decide<Q extends DecisionQuestion>(question: Q, span: Span): Promise<Decision<AnswerOf<Q>>> {
    assertQuestion(question);
    return span.run(
      "jev.route",
      async (s) => {
        const fallbacks: Decision<unknown>["fallbacks"] = [];
        for (const adapter of this.adapters) {
          const started = Date.now();
          try {
            const raw = await this.withTimeout(adapter, question, s);
            const value = validateAnswer(question, raw);
            const decision: Decision<AnswerOf<Q>> = {
              questionId: question.id,
              kind: question.kind,
              value: value as AnswerOf<Q>,
              confidence: clamp01(raw.confidence),
              probabilities: raw.probabilities,
              adapter: adapter.name,
              model: raw.model,
              latencyMs: Date.now() - started,
              usage: raw.usage,
              fallbacks,
            };
            s.setAttributes({
              "jev.adapter": adapter.name,
              "jev.model": raw.model,
              "jev.answer": String(decision.value),
              "jev.confidence": Number(decision.confidence.toFixed(3)),
              "jev.latency_ms": decision.latencyMs,
              "jev.fallbacks": fallbacks.map((f) => `${f.adapter}:${f.reason}`).join("; ") || undefined,
            });
            return decision;
          } catch (err) {
            fallbacks.push({ adapter: adapter.name, reason: reasonOf(err) });
          }
        }
        throw new MotionError("INTERNAL", `No decision adapter answered ${question.id}`, {
          details: { fallbacks },
        });
      },
      { "jev.question": question.id, "jev.kind": question.kind },
    );
  }

  private async withTimeout(
    adapter: DecisionAdapter,
    question: DecisionQuestion,
    span: Span,
  ): Promise<AdapterAnswer> {
    if (adapter.name === "rules") return adapter.answer(question, span, new AbortController().signal);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Settle the race before aborting so the timeout, not the adapter's abort error, is reported.
        reject(new MotionError("TIMEOUT", `${adapter.name} timed out after ${this.timeoutMs}ms`));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([adapter.answer(question, span, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertQuestion(q: DecisionQuestion): void {
  if (!q.id || !q.instructions)
    throw new MotionError("VALIDATION", "decision question needs id and instructions");
  if (q.kind === "choice" && Object.keys(q.options).length < 2) {
    throw new MotionError("VALIDATION", `choice question ${q.id} needs at least two options`);
  }
  if (q.kind === "score" && q.levels.length < 2) {
    throw new MotionError("VALIDATION", `score question ${q.id} needs at least two levels`);
  }
}

function validateAnswer(question: DecisionQuestion, raw: AdapterAnswer): string | number {
  if (question.kind === "choice") {
    if (typeof raw.value !== "string" || !Object.hasOwn(question.options, raw.value)) {
      throw new MotionError("PROVIDER", `answer "${String(raw.value)}" is not an option of ${question.id}`);
    }
    return raw.value;
  }
  if (
    typeof raw.value !== "number" ||
    !Number.isFinite(raw.value) ||
    raw.value < -0.001 ||
    raw.value > 1.001
  ) {
    throw new MotionError("PROVIDER", `answer for ${question.id} is not a 0-1 number`);
  }
  return clamp01(raw.value);
}

function reasonOf(err: unknown): string {
  if (err instanceof MotionError) return `${err.code}: ${redact(err.message).slice(0, 160)}`;
  return redact(err instanceof Error ? err.message : String(err)).slice(0, 160);
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
