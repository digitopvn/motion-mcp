import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startTrace } from "@motion-mcp/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PiWorker } from "../src/pi-worker.ts";
import { context, scene } from "./fixtures.ts";

// Offline: Pi's faux provider scripts the assistant turns; the real Pi session, tools and guard run.
const base = mkdtempSync(join(tmpdir(), "pi-worker-test-"));
let runtime: ModelRuntime;
let faux: FauxProviderHandle;
let projectDir: string;

const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const html = '<template><div data-composition-id="intro" data-start="0" data-duration="4"></div></template>';

beforeAll(async () => {
  runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  faux = fauxProvider({ provider: "faux-test", models: [{ id: "coder-1" }] });
  runtime.registerNativeProvider(faux.provider);
});

beforeEach(() => {
  projectDir = mkdtempSync(join(base, "project-"));
  mkdirSync(join(projectDir, "compositions"));
  writeFileSync(join(projectDir, "motion-ir.json"), '{"secret":"do not read"}');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const worker = (opts: { maxTurns?: number } = {}) =>
  new PiWorker({
    modelRuntime: runtime,
    provider: "faux-test",
    model: "coder-1",
    agentDir: join(base, "agent"),
    ...opts,
  });

describe("PiWorker.buildScene", () => {
  it("writes only the guarded scene file, validates submit_scene, and traces the run", async () => {
    faux.setResponses([
      toolUse("write", { path: "../escape.html", content: "x" }),
      toolUse("read", { path: "motion-ir.json" }),
      toolUse("write", { path: "compositions/intro.html", content: html }),
      toolUse("submit_scene", { files: ["compositions/other.html"], notes: "wrong file" }),
      toolUse("submit_scene", { files: ["compositions/intro.html"], notes: "Mask reveal then fade-up." }),
      fauxAssistantMessage("must not be requested"),
    ]);
    const root = startTrace("video.generate");
    const result = await worker().buildScene({
      projectDir,
      sceneId: "intro",
      sceneIR: scene,
      context,
      span: root,
    });
    root.end();

    expect(result).toMatchObject({
      sceneId: "intro",
      files: ["compositions/intro.html"],
      notes: "Mask reveal then fade-up.",
      runtime: "pi",
      model: "coder-1",
    });
    expect(readFileSync(join(projectDir, "compositions", "intro.html"), "utf8")).toBe(html);
    expect(existsSync(join(base, "escape.html"))).toBe(false);
    expect(faux.getPendingResponseCount()).toBe(1); // terminate:true ended the run without another LLM turn
    expect(result.counters).toMatchObject({ blockedCalls: 2, assistantMessages: 5, toolCalls: 5 });

    const pi = root.data.children[0];
    expect(pi?.name).toBe("pi.execute");
    expect(pi?.attributes).toMatchObject({ "pi.task": "build", "pi.model": "coder-1", "scene.id": "intro" });
    const sceneSpan = pi?.children[0];
    expect(sceneSpan?.name).toBe("scene.intro");
    expect(sceneSpan?.status).toBe("ok");
    expect(sceneSpan?.modelCalls).toHaveLength(5);
    expect(sceneSpan?.attributes).toMatchObject({ "pi.blocked_calls": 2, "pi.tool.submit_scene": 2 });
    expect(Number(sceneSpan?.attributes["pi.prompt_tokens_est"])).toBeGreaterThan(100);
  });

  it("fails with BUDGET_EXCEEDED when the model loops past maxTurns", async () => {
    faux.setResponses(Array.from({ length: 10 }, () => toolUse("ls", {})));
    const root = startTrace("job");
    await expect(
      worker({ maxTurns: 2 }).buildScene({ projectDir, sceneId: "intro", sceneIR: scene, span: root }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(root.data.children[0]?.status).toBe("error");
    faux.setResponses([]);
  });

  it("fails retryably when the model never submits", async () => {
    faux.setResponses([fauxAssistantMessage("I think the scene looks great.")]);
    await expect(worker().buildScene({ projectDir, sceneId: "intro", sceneIR: scene })).rejects.toMatchObject(
      {
        code: "PROVIDER",
        retryable: true,
      },
    );
  });

  it("validates inputs before starting a session", async () => {
    const w = worker();
    await expect(w.buildScene({ projectDir, sceneId: "../x", sceneIR: scene })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      w.buildScene({ projectDir: "relative", sceneId: "intro", sceneIR: scene }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      w.buildScene({ projectDir, sceneId: "intro", sceneIR: scene, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      w.buildScene({ projectDir, sceneId: "intro", sceneIR: scene, model: "missing-model" }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("PiWorker.patchScene", () => {
  it("edits the existing scene file and submits", async () => {
    writeFileSync(join(projectDir, "compositions", "intro.html"), html);
    faux.setResponses([
      toolUse("read", { path: "compositions/intro.html" }),
      toolUse("edit", {
        path: "compositions/intro.html",
        edits: [{ oldText: 'data-duration="4"', newText: 'data-duration="4.5"' }],
      }),
      toolUse("submit_scene", { files: ["compositions/intro.html"], notes: "Extended hold." }),
    ]);
    const result = await worker().patchScene({
      projectDir,
      sceneId: "intro",
      patch: {
        sceneId: "intro",
        source: "opus",
        changes: [{ type: "timing", instruction: "Hold the final frame longer" }],
      },
    });
    expect(result.notes).toBe("Extended hold.");
    expect(readFileSync(join(projectDir, "compositions", "intro.html"), "utf8")).toContain(
      'data-duration="4.5"',
    );
  });

  it("rejects patches for scenes that were never built", async () => {
    await expect(worker().patchScene({ projectDir, sceneId: "intro", qaIssues: [] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
