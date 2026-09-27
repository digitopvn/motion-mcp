import { ScriptedGateway } from "@motion-mcp/llm";
import { MECHANICAL_CATEGORIES, type QaCategory, type QaIssue } from "@motion-mcp/motion-ir";
import { type SpanData, startTrace, summarize } from "@motion-mcp/observability";
import { loadConfig, MotionError } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import {
  classifyIssue,
  createDecisionClient,
  type DecisionAdapter,
  DecisionChain,
  type DecisionClient,
  estimateCritiqueCostUsd,
  type IssueClassification,
  isRenderJustified,
  LlmDecisionClient,
  RuleDecisionClient,
  routeIntent,
  selectModel,
  shouldEscalateToOpus,
  shouldGenerateAsset,
  shouldRetry,
  TypeSafeJevClient,
  type YesNoQuestion,
} from "../src/index.ts";

const TS_KEY = "ts_live_0123456789abcdef0123";

const issue = (category: QaCategory, extra: Partial<QaIssue> = {}): QaIssue => ({
  id: `q-${category}`,
  sceneId: "s01-hook",
  category,
  severity: "warn",
  message: `${category} detected`,
  source: "check",
  ...extra,
});

/** Client that fails the test if any decision is requested. */
const noModelClient: DecisionClient = {
  decide: () => {
    throw new Error("a model decision was requested");
  },
};

const findSpans = (root: SpanData, name: string): SpanData[] => [
  ...(root.name === name ? [root] : []),
  ...root.children.flatMap((c) => findSpans(c, name)),
];

const question: YesNoQuestion = {
  kind: "yesno",
  id: "needs_opus",
  instructions: "Does this need Opus?",
  state: { issue: "flat hierarchy" },
  rule: () => 0.2,
};

describe("classifyIssue", () => {
  it("resolves every mechanical category by rules without any model call", async () => {
    const span = startTrace("t");
    for (const category of MECHANICAL_CATEGORIES) {
      const c = await classifyIssue(
        issue(category),
        { directorMode: "internal-opus" },
        { decisions: noModelClient, span },
      );
      expect(c.decidedBy).toBe("rules");
      expect(c.needsOpus).toBe(false);
      expect(c.cheapFixable).toBe(true);
      expect(c.worker).not.toBe("opus");
    }
    expect(summarize(span.data).modelCalls).toBe(0);
    expect(findSpans(span.data, "jev.route")).toHaveLength(MECHANICAL_CATEGORIES.size);
  });

  it("escalates a layout issue that survived two cheap attempts, still without a model call", async () => {
    const c = await classifyIssue(
      issue("overflow"),
      { directorMode: "internal-opus", attempts: 2 },
      { decisions: noModelClient, span: startTrace("t") },
    );
    expect(c).toMatchObject({ needsOpus: true, worker: "opus", cheapFixable: false });
    const asset = await classifyIssue(
      issue("broken_image"),
      { directorMode: "internal-opus", attempts: 2 },
      { decisions: noModelClient, span: startTrace("t") },
    );
    expect(asset).toMatchObject({ needsOpus: false, worker: "asset" });
  });

  it("asks the decision chain for creative issues", async () => {
    const gateway = new ScriptedGateway([
      '{"choice":"creative_direction","confidence":0.9}',
      '{"probability":0.1}',
    ]);
    const client = createDecisionClient(loadConfig({}), { gateway });
    const span = startTrace("t");
    const c = await classifyIssue(
      issue("creative"),
      { directorMode: "internal-opus" },
      { decisions: client, span },
    );
    expect(c).toMatchObject({
      rootCause: "creative_direction",
      needsOpus: true,
      worker: "opus",
      decidedBy: "llm",
    });
    expect(gateway.callCount).toBe(2);
    expect(gateway.requests[0]!.model).toBe("deepseek/deepseek-v4-flash");
    const routes = findSpans(span.data, "jev.route");
    expect(routes.map((r) => r.attributes["jev.question"])).toEqual(["root_cause", "cheap_fixable"]);
    expect(routes[0]!.attributes["jev.adapter"]).toBe("llm");
    expect(summarize(span.data).modelCalls).toBe(2);
  });
});

describe("decision chain", () => {
  it("falls back TypeSafe → LLM → rules in order and records reasons", async () => {
    const calls: string[] = [];
    const fetchImpl = async () => {
      calls.push("typesafe");
      return new Response("upstream down", { status: 503 });
    };
    const gateway = new ScriptedGateway([
      (req) => {
        calls.push(`llm:${req.model}`);
        return "garbage";
      },
      () => "still garbage",
    ]);
    const client = createDecisionClient(loadConfig({ TYPESAFE_API_KEY: TS_KEY }), {
      gateway,
      fetch: fetchImpl,
    });
    expect(client.adapters.map((a) => a.name)).toEqual(["typesafe", "llm", "rules"]);
    const span = startTrace("t");
    const d = await client.decide(question, span);
    expect(d.adapter).toBe("rules");
    expect(d.value).toBe(0.2);
    expect(d.fallbacks.map((f) => f.adapter)).toEqual(["typesafe", "llm"]);
    expect(calls).toEqual(["typesafe", "llm:deepseek/deepseek-v4-flash"]);
    const route = findSpans(span.data, "jev.route")[0]!;
    expect(route.attributes["jev.adapter"]).toBe("rules");
    expect(String(route.attributes["jev.fallbacks"])).toContain("typesafe:PROVIDER");
    expect(JSON.stringify(span.data)).not.toContain(TS_KEY);
  });

  it("uses only rules when no keys or gateway are configured", () => {
    const client = createDecisionClient(loadConfig({}));
    expect(client.adapters.map((a) => a.name)).toEqual(["rules"]);
  });

  it("times out a slow adapter and falls through", async () => {
    const slow: DecisionAdapter = {
      name: "typesafe",
      answer: (_q, _s, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const chain = new DecisionChain([slow, new RuleDecisionClient()], { timeoutMs: 20 });
    const d = await chain.decide(question, startTrace("t"));
    expect(d.adapter).toBe("rules");
    expect(d.fallbacks[0]!.reason).toContain("TIMEOUT");
  });

  it("rejects answers outside the declared options", async () => {
    const liar: DecisionAdapter = { name: "llm", answer: async () => ({ value: "banana", confidence: 1 }) };
    const chain = new DecisionChain([liar, new RuleDecisionClient()]);
    const d = await chain.decide(
      {
        kind: "choice",
        id: "worker",
        instructions: "who?",
        state: {},
        options: { pi: "pi", opus: "opus" },
        rule: () => "pi",
      },
      startTrace("t"),
    );
    expect(d.value).toBe("pi");
    expect(d.adapter).toBe("rules");
  });

  it("refuses the OpenRouter jev-router chat model as a decision model", () => {
    expect(
      () => new LlmDecisionClient({ gateway: new ScriptedGateway([]), model: "typesafe/jev-router" }),
    ).toThrow(MotionError);
  });
});

describe("TypeSafeJevClient", () => {
  it("posts {model, state, questions} to /v1/systemone and maps typed answers", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const replies = [
      {
        model: "jev-1.13.0",
        answers: { needs_opus: { type: "noul", noul: 0.95 } },
        usage: { input_tokens: 296, output_tokens: 20 },
      },
      {
        model: "jev-1.13.0",
        answers: {
          worker: {
            type: "choice",
            choice: "opus",
            probabilities: { pi: 0.12, opus: 0.88 },
            confidence: 0.81,
          },
        },
      },
      { answers: { severity: { type: "score", score: 1, confidence: 0.9 } } },
    ];
    const fetchImpl = async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    };
    const client = new TypeSafeJevClient({ apiKey: TS_KEY, model: "jev-latest", fetch: fetchImpl });
    const span = startTrace("t");

    const yes = await client.decide(
      { ...question, state: { note: `token=${TS_KEY}` }, criteria: { yes: "creative", no: "mechanical" } },
      span,
    );
    expect(yes.value).toBe(0.95);
    expect(yes.adapter).toBe("typesafe");
    expect(requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TS_KEY}`);
    const body = JSON.parse(String(requests[0]!.init.body));
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-latest");
    expect(typeof body.state).toBe("string");
    expect(body.state).not.toContain(TS_KEY);
    expect(body.questions).toEqual({
      needs_opus: {
        type: "noul",
        instructions: "Does this need Opus?",
        criteria: { true: "creative", false: "mechanical" },
      },
    });
    expect(yes.usage?.costUsd).toBeCloseTo((296 * 0.042) / 1e6, 12);

    const choice = await client.decide(
      {
        kind: "choice",
        id: "worker",
        instructions: "Which worker?",
        state: {},
        options: { pi: "code", opus: "taste" },
        rule: () => "pi",
      },
      span,
    );
    expect(choice).toMatchObject({ value: "opus", confidence: 0.81 });
    expect(JSON.parse(String(requests[1]!.init.body)).questions.worker).toEqual({
      type: "choice",
      instructions: "Which worker?",
      criteria: { pi: "code", opus: "taste" },
    });

    const score = await client.decide(
      {
        kind: "score",
        id: "severity",
        instructions: "How bad?",
        state: {},
        levels: ["ok", "meh", "bad"],
        rule: () => 0,
      },
      span,
    );
    expect(score.value).toBe(0.5);
    expect(JSON.parse(String(requests[2]!.init.body)).questions.severity.criteria).toEqual([
      "ok",
      "meh",
      "bad",
    ]);
    expect(summarize(span.data).costByProvider.typesafe).toBeGreaterThan(0);
  });
});

describe("policies", () => {
  const creative: IssueClassification = {
    issueId: "q1",
    rootCause: "creative_direction",
    cheapFixable: false,
    worker: "opus",
    needsOpus: true,
    confidence: 0.9,
    decidedBy: "llm",
  };
  const base = {
    issues: [creative],
    loop: 0,
    budgetRemainingUsd: 5,
    mode: "internal-opus" as const,
    critiqueModel: "anthropic/claude-opus-5.5",
    critiquesForScene: 0,
    critiquesForJob: 0,
  };

  it("escalates creative issues only within budget and caps", () => {
    const cost = estimateCritiqueCostUsd("anthropic/claude-opus-5.5");
    expect(cost).toBeCloseTo((8000 * 4 + 2000 * 20) / 1e6, 9);
    expect(shouldEscalateToOpus(base).ok).toBe(true);
    expect(shouldEscalateToOpus({ ...base, budgetRemainingUsd: cost - 0.001 }).ok).toBe(false);
    expect(shouldEscalateToOpus({ ...base, critiquesForScene: 1 }).ok).toBe(false);
    expect(shouldEscalateToOpus({ ...base, critiquesForJob: 2 }).ok).toBe(false);
    expect(shouldEscalateToOpus({ ...base, loop: 3 }).ok).toBe(false);
    expect(shouldEscalateToOpus({ ...base, issues: [{ ...creative, needsOpus: false }] }).ok).toBe(false);
    expect(shouldEscalateToOpus({ ...base, mode: "host-opus", budgetRemainingUsd: 0 }).ok).toBe(true);
    expect(estimateCritiqueCostUsd("unknown/model")).toBe(cost);
  });

  it("gates renders", () => {
    const r = {
      kind: "preview" as const,
      lintErrors: 0,
      checkErrors: 2,
      changedSinceLastRender: true,
      budgetRemainingUsd: 1,
      estimatedRenderCostUsd: 0.01,
    };
    expect(isRenderJustified(r).ok).toBe(true);
    expect(isRenderJustified({ ...r, kind: "final" }).ok).toBe(false);
    expect(isRenderJustified({ ...r, lintErrors: 1 }).ok).toBe(false);
    expect(isRenderJustified({ ...r, changedSinceLastRender: false }).ok).toBe(false);
    expect(isRenderJustified({ ...r, budgetRemainingUsd: 0 }).ok).toBe(false);
  });

  it("gates generated assets by the per-job cap, and by budget only when the server pays", () => {
    const a = { byok: false, generatedForJob: 0, maxPerJob: 2, budgetRemainingUsd: 1, estimatedCostUsd: 0.1 };
    expect(shouldGenerateAsset(a).ok).toBe(true);
    expect(shouldGenerateAsset({ ...a, generatedForJob: 2 }).ok).toBe(false);
    expect(shouldGenerateAsset({ ...a, budgetRemainingUsd: 0.05 }).ok).toBe(false);
    expect(shouldGenerateAsset({ ...a, byok: true, budgetRemainingUsd: 0 }).ok).toBe(true);
    expect(shouldGenerateAsset({ ...a, byok: true, generatedForJob: 2 }).ok).toBe(false);
    expect(shouldGenerateAsset({ ...a, maxPerJob: 0 }).ok).toBe(false);
  });

  it("retries only transient errors", () => {
    expect(shouldRetry({ error: new MotionError("TIMEOUT", "t"), attempt: 1 }).ok).toBe(true);
    expect(
      shouldRetry({ error: new MotionError("PROVIDER", "p", { retryable: true }), attempt: 2 }).delayMs,
    ).toBe(2000);
    expect(shouldRetry({ error: new MotionError("PROVIDER", "p", { retryable: true }), attempt: 3 }).ok).toBe(
      false,
    );
    expect(
      shouldRetry({ error: new MotionError("VALIDATION", "v", { retryable: true }), attempt: 1 }).ok,
    ).toBe(false);
    expect(shouldRetry({ error: new Error("boom"), attempt: 1 }).ok).toBe(false);
  });

  it("routes intent and selects configured models", () => {
    expect(routeIntent("", true).directorNeeded).toBe(false);
    expect(routeIntent("make a video", false).directorNeeded).toBe(true);
    expect(() => routeIntent("  ", false)).toThrow(MotionError);
    const config = loadConfig({ DIRECTOR_MODEL: "x/director", CODER_MODEL: "x/coder" });
    expect(selectModel("critique", config)).toBe("x/director");
    expect(selectModel("code", config)).toBe("x/coder");
    expect(selectModel("decision", config)).toBe(config.DECISION_MODEL);
    expect(selectModel("vision", config)).toBe(config.VISION_MODEL);
  });
});
