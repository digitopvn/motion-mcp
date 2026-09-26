import { startTrace } from "@motion-mcp/observability";
import { MotionError } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat, estimateCost, OpenRouterClient, ScriptedGateway, toResponseJsonSchema } from "../src/index.ts";

const KEY = "sk-or-v1-test0000000000000000000000000000";

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const captured: Captured[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    captured.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  };
  return { captured, fetchImpl };
}

const ok = (
  content: string,
  usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 50 },
) => ({
  status: 200,
  body: {
    model: "anthropic/claude-opus-5.5",
    choices: [{ finish_reason: "stop", message: { content } }],
    usage,
  },
});

describe("OpenRouterClient", () => {
  it("sends json_schema structured output, require_parameters, usage include and cache_control", async () => {
    const { captured, fetchImpl } = fakeFetch([
      ok('{"a":1}', { prompt_tokens: 10, completion_tokens: 5, cost: 0.0123 }),
    ]);
    const client = new OpenRouterClient({ apiKey: KEY, fetch: fetchImpl, sleep: async () => {} });
    const result = await client.chat({
      model: "anthropic/claude-opus-5.5",
      messages: [
        { role: "system", content: "stable system prompt" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
      responseSchema: { name: "thing", schema: z.object({ a: z.number() }) },
      maxTokens: 100,
      cache: true,
    });
    expect(result.parsed).toEqual({ a: 1 });
    expect(result.usage.costUsd).toBe(0.0123);
    const req = captured[0]!;
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((req.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(req.body.usage).toEqual({ include: true });
    expect(req.body.provider).toEqual({ require_parameters: true });
    const rf = req.body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: object };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("thing");
    expect(rf.json_schema.strict).toBe(false);
    expect(rf.json_schema.schema).toMatchObject({ type: "object", properties: { a: { type: "number" } } });
    const messages = req.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "stable system prompt", cache_control: { type: "ephemeral" } },
    ]);
    expect(messages[1]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("does not add cache_control for non-Anthropic models", async () => {
    const { captured, fetchImpl } = fakeFetch([ok("hi")]);
    const client = new OpenRouterClient({ apiKey: KEY, fetch: fetchImpl });
    await client.chat({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "system", content: "sys" }],
      maxTokens: 10,
      cache: true,
    });
    expect((captured[0]!.body.messages as Array<{ content: unknown }>)[0]!.content).toBe("sys");
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const waits: number[] = [];
    const { captured, fetchImpl } = fakeFetch([
      { status: 429, body: { error: { message: "rate" } }, headers: { "retry-after": "2" } },
      { status: 503, body: "upstream" },
      ok("done"),
    ]);
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetch: fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const res = await client.chat({ model: "deepseek/deepseek-v4-flash", messages: [], maxTokens: 10 });
    expect(res.text).toBe("done");
    expect(captured).toHaveLength(3);
    expect(waits[0]).toBe(2000);
  });

  it("fails fast on 4xx with a redacted PROVIDER error", async () => {
    const { captured, fetchImpl } = fakeFetch([{ status: 400, body: `bad request for key ${KEY}` }]);
    const client = new OpenRouterClient({ apiKey: KEY, fetch: fetchImpl, sleep: async () => {} });
    const err = await client
      .chat({ model: "deepseek/deepseek-v4-flash", messages: [], maxTokens: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotionError);
    expect((err as MotionError).code).toBe("PROVIDER");
    expect(JSON.stringify((err as MotionError).details)).not.toContain(KEY);
    expect(captured).toHaveLength(1);
  });

  it("falls back to the PRICES table when the API returns no cost", async () => {
    const { fetchImpl } = fakeFetch([ok("x", { prompt_tokens: 1_000_000, completion_tokens: 100_000 })]);
    const client = new OpenRouterClient({ apiKey: KEY, fetch: fetchImpl });
    const res = await client.chat({ model: "anthropic/claude-opus-5.5", messages: [], maxTokens: 10 });
    expect(res.usage.costUsd).toBeCloseTo(4 + 2, 6);
  });

  it("rejects non-image URLs", async () => {
    const { fetchImpl } = fakeFetch([]);
    const client = new OpenRouterClient({ apiKey: KEY, fetch: fetchImpl });
    await expect(
      client.chat({
        model: "x/y",
        messages: [{ role: "user", content: [{ type: "image", url: "file:///etc/passwd" }] }],
        maxTokens: 10,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("chat structured output", () => {
  const schema = z.object({ n: z.number().int() });

  it("repairs once with validation issues and records every call on the span", async () => {
    const gateway = new ScriptedGateway(['```json\n{"n": "one"}\n```', '{"n": 1}']);
    const span = startTrace("test");
    const res = await chat(gateway, {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "give n" }],
      responseSchema: { name: "n", schema },
      maxTokens: 50,
      span,
    });
    expect(res.parsed).toEqual({ n: 1 });
    expect(res.calls).toHaveLength(2);
    expect(span.data.modelCalls).toHaveLength(2);
    const repair = gateway.requests[1]!.messages.at(-1)!;
    expect(String(repair.content)).toContain("did not match");
  });

  it("throws a typed error after the bounded repair fails", async () => {
    const gateway = new ScriptedGateway(["not json", "still not json", "never used"]);
    await expect(
      chat(gateway, { model: "m", messages: [], responseSchema: { name: "n", schema }, maxTokens: 10 }),
    ).rejects.toMatchObject({
      code: "PROVIDER",
      details: { reason: "invalid_structured_output", attempts: 2 },
    });
    expect(gateway.callCount).toBe(2);
  });
});

describe("estimateCost", () => {
  it("prices cache reads at the cache rate", () => {
    const cost = estimateCost("anthropic/claude-opus-5.5", {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadTokens: 8_000,
    });
    expect(cost).toBeCloseTo((2_000 * 4 + 8_000 * 0.2) / 1e6, 9);
    expect(estimateCost("unknown/model", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });
});

describe("schema transport", () => {
  it("falls back to prompt transport when the provider rejects the schema", async () => {
    const { captured, fetchImpl } = fakeFetch([
      {
        status: 400,
        body: { error: { message: "Schemas contains too many optional parameters (135)" } },
      },
      ok('{"a":2}'),
    ]);
    const client = new OpenRouterClient({ apiKey: KEY, fetch: fetchImpl, sleep: async () => {} });
    const span = startTrace("t");
    const res = await client.chat({
      model: "anthropic/fallback-test-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
      ],
      responseSchema: { name: "thing", schema: z.object({ a: z.number() }) },
      maxTokens: 50,
      cache: true,
      span,
    });
    expect(res.parsed).toEqual({ a: 2 });
    expect(res.calls).toHaveLength(1);
    expect(captured[1]!.body.response_format).toBeUndefined();
    const system = (
      captured[1]!.body.messages as Array<{ content: Array<{ text: string; cache_control?: object }> }>
    )[0]!;
    expect(system.content[1]!.text).toContain("JSON Schema");
    expect(system.content[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(span.data.attributes["llm.schema_fallback"]).toBe(true);
  });

  it("emits a provider-portable JSON Schema", () => {
    const schema = z.object({
      kind: z.discriminatedUnion("t", [z.object({ t: z.literal("a") }), z.object({ t: z.literal("b") })]),
      name: z.string().min(1).max(10),
      tags: z.array(z.string()).min(2),
    });
    const json = JSON.stringify(toResponseJsonSchema(schema));
    expect(json).not.toContain("oneOf");
    expect(json).not.toContain('"maxLength"');
    expect(json).toContain('"additionalProperties":false');
    expect(json).toContain("maxLength: 10");
  });
});
