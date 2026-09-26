import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ScriptedGateway } from "@motion-mcp/llm";
import { CreativeSpec, compileCreativeSpec, type QaIssue } from "@motion-mcp/motion-ir";
import { startTrace, summarize } from "@motion-mcp/observability";
import { MotionError } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import {
  buildHostCritiqueRequest,
  buildSceneCritiqueBundle,
  DIRECTOR_SYSTEM_PROMPT,
  Director,
  resolveDirectorMode,
} from "../src/index.ts";

const specJson = readFileSync(
  resolve(import.meta.dirname, "../../../fixtures/golden/product-launch/creative-spec.json"),
  "utf8",
);
const specInput: unknown = JSON.parse(specJson);
const spec = CreativeSpec.parse(specInput);
const MODEL = "anthropic/claude-opus-5.5";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("resolveDirectorMode", () => {
  it("honours explicit modes and never needs a model name", () => {
    expect(
      resolveDirectorMode({
        requested: "internal-opus",
        creativeSpecProvided: false,
        workspaceDefault: "custom",
      }),
    ).toEqual({ mode: "internal-opus", source: "requested" });
    expect(resolveDirectorMode({ creativeSpecProvided: true, workspaceDefault: "internal-opus" })).toEqual({
      mode: "host-opus",
      source: "creative-spec",
    });
    expect(resolveDirectorMode({ creativeSpecProvided: false, workspaceDefault: "custom" })).toEqual({
      mode: "custom",
      source: "workspace-default",
    });
  });

  it("rejects host-opus without a spec, with guidance", () => {
    expect(() =>
      resolveDirectorMode({
        requested: "host-opus",
        creativeSpecProvided: false,
        workspaceDefault: "internal-opus",
      }),
    ).toThrow(/motion_inspect/);
    expect(() =>
      resolveDirectorMode({
        requested: "internal-opus",
        creativeSpecProvided: true,
        workspaceDefault: "internal-opus",
      }),
    ).toThrow(MotionError);
  });
});

describe("Director.createCreativeSpec", () => {
  it("host-opus with a valid spec makes zero model calls", async () => {
    const gateway = new ScriptedGateway([]);
    const director = new Director({ gateway, directorModel: MODEL });
    const span = startTrace("test");
    const res = await director.createCreativeSpec(
      { brief: "ignored", mode: "host-opus", creativeSpec: specInput, format: { aspect: "9:16" } },
      span,
    );
    expect(gateway.callCount).toBe(0);
    expect(res.source).toBe("host");
    expect(res.spec.format?.aspect).toBe("9:16");
    expect(summarize(span.data).modelCalls).toBe(0);
  });

  it("host-opus without a spec, or with an invalid one, errors with VALIDATION", async () => {
    const director = new Director({ directorModel: MODEL });
    await expect(
      director.createCreativeSpec({ brief: "x", mode: "host-opus" }, startTrace("t")),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      director.createCreativeSpec(
        { brief: "x", mode: "host-opus", creativeSpec: { scenes: [] } },
        startTrace("t"),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("internal-opus returns a valid spec and records usage on the span", async () => {
    const gateway = new ScriptedGateway([{ text: specJson, inputTokens: 3000, outputTokens: 1800 }]);
    const director = new Director({ gateway, directorModel: MODEL });
    const span = startTrace("video.generate");
    const res = await director.createCreativeSpec(
      {
        brief: "Launch video for Tracewise, a distributed tracing tool.",
        mode: "internal-opus",
        format: { aspect: "16:9", duration: 24 },
        domainContext: ["Swiss editorial: grid, restraint, one accent."],
      },
      span,
    );
    expect(res.source).toBe("model");
    expect(res.spec.scenes.length).toBe(spec.scenes.length);
    const summary = summarize(span.data);
    expect(summary.modelCalls).toBe(1);
    expect(summary.opusCalls).toBe(1);
    expect(summary.apiCostUsd).toBeCloseTo((3000 * 4 + 1800 * 20) / 1e6, 9);

    const req = gateway.requests[0]!;
    expect(req.model).toBe(MODEL);
    expect(req.cache).toBe(true);
    expect(req.jsonSchema?.name).toBe("creative_spec");
    expect(req.messages[0]).toEqual({ role: "system", content: DIRECTOR_SYSTEM_PROMPT });
    const user = JSON.stringify(req.messages[1]);
    expect(user).toContain("Swiss editorial");
    expect(user).toContain("Target duration: 24 s");
  });

  it("custom mode uses the custom model and requires one", async () => {
    const gateway = new ScriptedGateway([specJson]);
    const director = new Director({ gateway, directorModel: MODEL });
    await expect(
      director.createCreativeSpec({ brief: "b", mode: "custom" }, startTrace("t")),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const res = await director.createCreativeSpec(
      { brief: "b", mode: "custom", customModel: "qwen/qwen3.8-flash" },
      startTrace("t"),
    );
    expect(res.model).toBe("qwen/qwen3.8-flash");
    expect(gateway.requests[0]!.model).toBe("qwen/qwen3.8-flash");
  });

  it("invalid model JSON triggers exactly one repair, then a typed error", async () => {
    const gateway = new ScriptedGateway(['{"tastePacket": {}}', "{ not json", specJson]);
    const director = new Director({ gateway, directorModel: MODEL });
    const span = startTrace("t");
    const err = await director
      .createCreativeSpec({ brief: "b", mode: "internal-opus" }, span)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotionError);
    expect((err as MotionError).code).toBe("PROVIDER");
    expect((err as MotionError).details?.reason).toBe("invalid_structured_output");
    expect(gateway.callCount).toBe(2);
    expect(String(gateway.requests[1]!.messages.at(-1)!.content)).toContain("did not match");
    expect(summarize(span.data).modelCalls).toBe(2);
  });

  it("a repair that fixes the JSON succeeds", async () => {
    const gateway = new ScriptedGateway(["Here you go: {oops}", specJson]);
    const director = new Director({ gateway, directorModel: MODEL });
    const res = await director.createCreativeSpec({ brief: "b", mode: "internal-opus" }, startTrace("t"));
    expect(res.modelCalls).toHaveLength(2);
  });
});

describe("scene critique", () => {
  const ir = compileCreativeSpec(spec, { id: "proj_test" });
  const target = ir.scenes[1]!;
  const other = ir.scenes[2]!;
  const issues: QaIssue[] = [
    {
      id: "q1",
      sceneId: target.id,
      category: "creative",
      severity: "warn",
      message: "flat",
      source: "critique",
    },
    {
      id: "q2",
      sceneId: other.id,
      category: "creative",
      severity: "warn",
      message: "other",
      source: "critique",
    },
  ];

  it("bundle contains only the target scene", () => {
    const bundle = buildSceneCritiqueBundle(
      ir,
      target.id,
      { contactSheet: PNG, qaIssues: issues },
      spec.tastePacket,
    );
    expect(bundle.sceneIR.id).toBe(target.id);
    expect(bundle.qaDiagnosis.map((i) => i.id)).toEqual(["q1"]);
    const text = JSON.stringify(bundle);
    for (const s of ir.scenes) if (s.id !== target.id) expect(text).not.toContain(`"${s.id}"`);
    for (const el of other.elements) {
      if (el.kind === "text") expect(text).not.toContain(el.text);
    }
    expect(bundle.globalIntent.sceneCount).toBe(ir.scenes.length);
  });

  it("critiqueScene returns an opus ScenePatch pinned to the scene and repairs bad targets", async () => {
    const bundle = buildSceneCritiqueBundle(
      ir,
      target.id,
      { contactSheet: PNG, qaIssues: issues },
      spec.tastePacket,
    );
    const el = target.elements[0]!.id;
    const bad = JSON.stringify({
      sceneId: "other",
      changes: [{ type: "timing", instruction: "slower", target: "nope" }],
    });
    const good = JSON.stringify({
      sceneId: "whatever",
      changes: [
        { type: "timing", instruction: "hold hero longer", target: el, params: { durationSeconds: 1.2 } },
      ],
    });
    const gateway = new ScriptedGateway([bad, good]);
    const director = new Director({ gateway, directorModel: MODEL });
    const span = startTrace("t");
    const res = await director.critiqueScene(bundle, span, { mode: "internal-opus" });
    expect(res.patch.sceneId).toBe(target.id);
    expect(res.patch.source).toBe("opus");
    expect(res.patch.changes[0]!.target).toBe(el);
    expect(gateway.callCount).toBe(2);
    const content = gateway.requests[0]!.messages[1]!.content;
    expect(Array.isArray(content) && content.some((p) => p.type === "image" && p.url === PNG)).toBe(true);
    expect(summarize(span.data).modelCalls).toBe(2);
  });

  it("host mode builds a critique request with no model call", async () => {
    const bundle = buildSceneCritiqueBundle(ir, target.id, { contactSheet: PNG }, spec.tastePacket);
    const req = buildHostCritiqueRequest(bundle);
    expect(req.sceneId).toBe(target.id);
    expect(req.requestId).toMatch(/^crq_/);
    expect(req.responseSchema).toMatchObject({ type: "object" });
    const director = new Director({ directorModel: MODEL });
    await expect(
      director.critiqueScene(bundle, startTrace("t"), { mode: "host-opus" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
