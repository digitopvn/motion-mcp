import type { ModelUsage } from "@motion-mcp/observability";
import { MotionError } from "@motion-mcp/shared";
import { estimateCost } from "./prices.ts";
import type { Completion, CompletionRequest, ModelGateway } from "./types.ts";

export type ScriptedReply =
  | string
  | { text: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | ((request: CompletionRequest) => string | Completion);

/**
 * Deterministic gateway that replays fixture replies in order and records every request.
 * For tests and offline fixtures only; it never touches the network.
 */
export class ScriptedGateway implements ModelGateway {
  readonly requests: CompletionRequest[] = [];
  private readonly replies: ScriptedReply[];

  constructor(replies: ScriptedReply[]) {
    this.replies = [...replies];
  }

  get callCount(): number {
    return this.requests.length;
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (reply === undefined) {
      throw new MotionError(
        "INTERNAL",
        `ScriptedGateway exhausted after ${this.requests.length - 1} replies`,
      );
    }
    if (typeof reply === "function") {
      const out = reply(request);
      return typeof out === "string" ? { text: out, usage: fakeUsage(request.model, out) } : out;
    }
    if (typeof reply === "string") return { text: reply, usage: fakeUsage(request.model, reply) };
    return { text: reply.text, usage: fakeUsage(request.model, reply.text, reply) };
  }
}

function fakeUsage(
  model: string,
  text: string,
  override: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {},
): ModelUsage {
  const inputTokens = override.inputTokens ?? 1000;
  const outputTokens = override.outputTokens ?? Math.ceil(text.length / 4);
  const costUsd = override.costUsd ?? estimateCost(model, { inputTokens, outputTokens }) ?? 0;
  return { model, provider: "scripted", inputTokens, outputTokens, costUsd };
}
