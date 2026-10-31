import Anthropic from "@anthropic-ai/sdk";
import { AUTH_REJECTED, MotionError } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicClient, type AnthropicSdkClient, buildAnthropicRequest, chat } from "../src/index.ts";

const KEY = "sk-ant-api03-test000000000000000000000000";

function message(text: string, overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  } as Anthropic.Message;
}

function fakeSdk(replies: Array<Anthropic.Message | Error>) {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let listed = 0;
  let listError: Error | undefined;
  const client: AnthropicSdkClient = {
    messages: {
      async create(body) {
        bodies.push(body);
        const next = replies.shift();
        if (!next) throw new Error("no more replies");
        if (next instanceof Error) throw next;
        return next;
      },
    },
    models: {
      async list() {
        listed++;
        if (listError) throw listError;
        return { data: [] };
      },
    },
  };
  return {
    client,
    bodies,
    get listed() {
      return listed;
    },
    failList(err: Error) {
      listError = err;
    },
  };
}

describe("buildAnthropicRequest", () => {
  it("splits system blocks, caches the stable prefix, converts images and drops temperature", () => {
    const body = buildAnthropicRequest({
      model: "claude-opus-5-5",
      maxTokens: 1000,
      temperature: 0.7,
      cache: true,
      jsonSchema: { name: "spec", schema: { type: "object" } },
      messages: [
        { role: "system", content: "You are the director." },
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", url: "data:image/png;base64,AAAA" },
            { type: "image", url: "https://example.com/frame.jpg" },
          ],
        },
        { role: "user", content: "and this" },
      ],
    });
    expect(body.system).toEqual([
      { type: "text", text: "You are the director.", cache_control: { type: "ephemeral" } },
    ]);
    expect(body).not.toHaveProperty("temperature");
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } } });
    // Consecutive user turns merge so roles alternate.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "Look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://example.com/frame.jpg" } },
      { type: "text", text: "and this" },
    ]);
  });

  it("rejects non-https image URLs and unsupported image types", () => {
    const req = (url: string) =>
      buildAnthropicRequest({
        model: "claude-opus-5-5",
        maxTokens: 10,
        messages: [{ role: "user", content: [{ type: "image", url }] }],
      });
    expect(() => req("http://example.com/a.png")).toThrow(MotionError);
    expect(() => req("data:image/svg+xml;base64,AAAA")).toThrow(/unsupported image type/);
  });
});

describe("AnthropicClient", () => {
  it("requires a key", () => {
    expect(() => new AnthropicClient({ apiKey: "" })).toThrow(/not set/);
  });

  it("maps text and usage, counting cache reads into total input and estimating cost", async () => {
    const sdk = fakeSdk([message('{"ok":true}')]);
    const client = new AnthropicClient({ apiKey: KEY, client: sdk.client });
    const out = await client.complete({
      model: "claude-opus-5-5",
      maxTokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.text).toBe('{"ok":true}');
    expect(out.finishReason).toBe("end_turn");
    expect(out.usage).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 1100,
      outputTokens: 50,
      cacheReadTokens: 1000,
    });
    // 100 uncached * $4 + 1000 cached * $0.20 + 50 out * $20, per 1M tokens.
    expect(out.usage.costUsd).toBeCloseTo((100 * 4 + 1000 * 0.2 + 50 * 20) / 1e6, 10);
  });

  it("validates structured output through the shared chat helper", async () => {
    const sdk = fakeSdk([message("not json"), message('{"title":"Launch"}')]);
    const client = new AnthropicClient({ apiKey: KEY, client: sdk.client });
    const result = await chat(client, {
      model: "claude-opus-5-5",
      maxTokens: 100,
      messages: [{ role: "user", content: "spec" }],
      responseSchema: { name: "spec", schema: z.object({ title: z.string() }) },
    });
    expect(result.parsed).toEqual({ title: "Launch" });
    expect(result.calls).toHaveLength(2);
    expect(sdk.bodies[0]?.output_config?.format?.type).toBe("json_schema");
  });

  it("turns a refusal into a provider error", async () => {
    const sdk = fakeSdk([message("", { stop_reason: "refusal" })]);
    const client = new AnthropicClient({ apiKey: KEY, client: sdk.client });
    await expect(
      client.complete({
        model: "claude-opus-5-5",
        maxTokens: 10,
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER", details: { reason: "refusal" } });
  });

  it("maps a rejected key to an auth_rejected provider error without leaking the key", async () => {
    const auth = new Anthropic.AuthenticationError(401, undefined, `invalid x-api-key ${KEY}`, new Headers());
    const sdk = fakeSdk([auth]);
    const client = new AnthropicClient({ apiKey: KEY, client: sdk.client });
    const err = await client
      .complete({ model: "claude-opus-5-5", maxTokens: 10, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotionError);
    expect((err as MotionError).details?.reason).toBe(AUTH_REJECTED);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  it("maps rate limits to a retryable provider error and abort to CANCELLED", async () => {
    const limited = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    const sdk = fakeSdk([limited, new Anthropic.APIUserAbortError()]);
    const client = new AnthropicClient({ apiKey: KEY, client: sdk.client });
    const req = {
      model: "claude-opus-5-5",
      maxTokens: 10,
      messages: [{ role: "user" as const, content: "x" }],
    };
    await expect(client.complete(req)).rejects.toMatchObject({ code: "PROVIDER", retryable: true });
    await expect(client.complete(req)).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("verifies a key with the free models endpoint", async () => {
    const sdk = fakeSdk([]);
    const client = new AnthropicClient({ apiKey: KEY, client: sdk.client });
    await client.verifyKey();
    expect(sdk.listed).toBe(1);
    sdk.failList(new Anthropic.AuthenticationError(401, undefined, "nope", new Headers()));
    await expect(client.verifyKey()).rejects.toMatchObject({ details: { reason: AUTH_REJECTED } });
    // A 403 is a permission or region problem, not a bad key: it must not revoke the stored key.
    sdk.failList(new Anthropic.PermissionDeniedError(403, undefined, "nope", new Headers()));
    await expect(client.verifyKey()).rejects.toMatchObject({
      code: "PROVIDER",
      details: { reason: "permission_denied" },
    });
  });
});
