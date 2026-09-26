import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { Span } from "@motion-mcp/observability";
import { redact } from "@motion-mcp/shared";

/**
 * Maps Pi session events onto a Motion trace span: one `recordModelCall` per finished assistant message
 * (usage + cost as reported by Pi), tool activity as span attributes, provider retries as span retries.
 */

export interface PiRunCounters {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  blockedCalls: number;
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastStopReason?: string;
  lastError?: string;
}

export interface PiTraceMapper {
  readonly counters: PiRunCounters;
  handle(event: AgentSessionEvent): void;
  /** Record a tool call rejected by the path guard. */
  recordBlocked(toolName: string, reason: string): void;
  /** Copy authoritative session totals onto the span. */
  finish(stats?: SessionStats): void;
}

interface AssistantLike {
  role: "assistant";
  provider: string;
  model: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total: number };
  };
}

function asAssistant(message: unknown): AssistantLike | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Partial<AssistantLike>;
  return m.role === "assistant" ? (m as AssistantLike) : undefined;
}

export function createPiTraceMapper(span: Span, providerLabel?: string): PiTraceMapper {
  const counters: PiRunCounters = {
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    blockedCalls: 0,
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const toolCounts = new Map<string, number>();

  const handle = (event: AgentSessionEvent): void => {
    switch (event.type) {
      case "turn_start":
        counters.turns += 1;
        span.setAttributes({ "pi.turns": counters.turns });
        break;
      case "message_end": {
        const msg = asAssistant(event.message);
        if (!msg) break;
        counters.assistantMessages += 1;
        counters.lastStopReason = msg.stopReason;
        if (msg.errorMessage) counters.lastError = redact(msg.errorMessage).slice(0, 500);
        const usage = msg.usage;
        if (usage) {
          const costUsd = usage.cost?.total ?? 0;
          counters.inputTokens += usage.input;
          counters.outputTokens += usage.output;
          counters.costUsd += costUsd;
          span.recordModelCall({
            model: msg.model,
            provider: providerLabel ?? msg.provider,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            costUsd,
          });
        }
        break;
      }
      case "tool_execution_start": {
        counters.toolCalls += 1;
        const n = (toolCounts.get(event.toolName) ?? 0) + 1;
        toolCounts.set(event.toolName, n);
        span.setAttributes({ "pi.tool_calls": counters.toolCalls, [`pi.tool.${event.toolName}`]: n });
        break;
      }
      case "tool_execution_end":
        if (event.isError) {
          counters.toolErrors += 1;
          span.setAttributes({ "pi.tool_errors": counters.toolErrors, "pi.last_tool_error": event.toolName });
        }
        break;
      case "auto_retry_start":
        span.retry();
        break;
      default:
        break;
    }
  };

  return {
    counters,
    handle,
    recordBlocked(toolName, reason) {
      counters.blockedCalls += 1;
      span.setAttributes({
        "pi.blocked_calls": counters.blockedCalls,
        "pi.last_blocked": `${toolName}: ${redact(reason)}`.slice(0, 200),
      });
    },
    finish(stats) {
      if (stats) {
        span.setAttributes({
          "pi.session.input_tokens": stats.tokens.input,
          "pi.session.output_tokens": stats.tokens.output,
          "pi.session.cache_read_tokens": stats.tokens.cacheRead,
          "pi.session.cost_usd": stats.cost,
          "pi.session.tool_calls": stats.toolCalls,
          "pi.session.assistant_messages": stats.assistantMessages,
        });
      }
      if (counters.lastStopReason) span.setAttributes({ "pi.stop_reason": counters.lastStopReason });
    },
  };
}
