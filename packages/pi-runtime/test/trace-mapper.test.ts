import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { startTrace, summarize } from "@motion-mcp/observability";
import { describe, expect, it } from "vitest";
import { createPiTraceMapper } from "../src/trace-mapper.ts";

const assistantEnd = (input: number, output: number, cost: number, extra: Record<string, unknown> = {}) =>
  ({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      api: "openai-completions",
      content: [],
      stopReason: "toolUse",
      timestamp: 0,
      usage: {
        input,
        output,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      ...extra,
    },
  }) as unknown as AgentSessionEvent;

describe("createPiTraceMapper", () => {
  it("records one model call per assistant message and tool activity as attributes", () => {
    const root = startTrace("job");
    const span = root.child("scene.intro");
    const mapper = createPiTraceMapper(span);
    const events: AgentSessionEvent[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      assistantEnd(1000, 50, 0.0001),
      {
        type: "tool_execution_start",
        toolCallId: "1",
        toolName: "write",
        args: { path: "compositions/intro.html" },
      },
      { type: "tool_execution_end", toolCallId: "1", toolName: "write", result: {}, isError: false },
      { type: "turn_start" },
      assistantEnd(1200, 30, 0.0002),
      { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: { path: "../x" } },
      { type: "tool_execution_end", toolCallId: "2", toolName: "read", result: {}, isError: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: "429" },
      { type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } } as AgentSessionEvent,
    ];
    for (const e of events) mapper.handle(e);
    mapper.recordBlocked("read", "path ../x is outside the project directory");
    mapper.finish();
    span.end();
    root.end();

    expect(span.data.modelCalls).toHaveLength(2);
    expect(span.data.modelCalls[0]).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: "openrouter",
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 10,
    });
    expect(span.data.attributes).toMatchObject({
      "pi.turns": 2,
      "pi.tool_calls": 2,
      "pi.tool.write": 1,
      "pi.tool.read": 1,
      "pi.tool_errors": 1,
      "pi.blocked_calls": 1,
      "pi.stop_reason": "toolUse",
    });
    expect(span.data.retries).toBe(1);
    const summary = summarize(root.data);
    expect(summary.apiCostUsd).toBeCloseTo(0.0003, 8);
    expect(summary.inputTokens).toBe(2200);
    expect(summary.costByModel["deepseek/deepseek-v4-flash"]).toBeCloseTo(0.0003, 8);
    expect(mapper.counters).toMatchObject({ assistantMessages: 2, inputTokens: 2200, outputTokens: 80 });
  });

  it("keeps a redacted provider error and copies session totals", () => {
    const span = startTrace("scene.x");
    const mapper = createPiTraceMapper(span, "openrouter");
    mapper.handle(
      assistantEnd(10, 0, 0, {
        stopReason: "error",
        errorMessage: "401 bad key sk-or-v1-abcdefghijklmnopqrstuvwxyz",
      }),
    );
    mapper.finish({
      sessionFile: undefined,
      sessionId: "s",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
      cost: 0,
    });
    expect(mapper.counters.lastError).toContain("[redacted]");
    expect(mapper.counters.lastError).not.toContain("abcdefghijklmnop");
    expect(span.data.attributes["pi.session.input_tokens"]).toBe(10);
    expect(span.data.attributes["pi.stop_reason"]).toBe("error");
  });
});
