import type { ModelGateway } from "@motion-mcp/llm";
import type { MotionConfig } from "@motion-mcp/shared";
import {
  type FetchLike,
  LlmDecisionClient,
  RuleDecisionClient,
  TypeSafeJevClient,
} from "./decision-adapters.ts";
import { DecisionChain } from "./decision-chain.ts";
import type { DecisionAdapter } from "./decision-types.ts";

export type DecisionConfig = Pick<
  MotionConfig,
  "TYPESAFE_API_KEY" | "TYPESAFE_BASE_URL" | "JEV_MODEL" | "DECISION_MODEL"
>;

export interface DecisionClientDeps {
  /** OpenRouter gateway; the LLM adapter is enabled only when present. */
  gateway?: ModelGateway;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Build the decision chain TypeSafe Jev → LLM → rules. TypeSafe is enabled only with `TYPESAFE_API_KEY`;
 * the LLM adapter only with a gateway; rules always answer last.
 */
export function createDecisionClient(config: DecisionConfig, deps: DecisionClientDeps = {}): DecisionChain {
  const adapters: DecisionAdapter[] = [];
  if (config.TYPESAFE_API_KEY) {
    adapters.push(
      new TypeSafeJevClient({
        apiKey: config.TYPESAFE_API_KEY,
        baseUrl: config.TYPESAFE_BASE_URL,
        model: config.JEV_MODEL,
        fetch: deps.fetch,
      }),
    );
  }
  if (deps.gateway)
    adapters.push(new LlmDecisionClient({ gateway: deps.gateway, model: config.DECISION_MODEL }));
  adapters.push(new RuleDecisionClient());
  return new DecisionChain(adapters, { timeoutMs: deps.timeoutMs });
}
