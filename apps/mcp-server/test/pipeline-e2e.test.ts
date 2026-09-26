import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHyperframesAdapter } from "@motion-mcp/hyperframes-adapter";
import { ScriptedGateway } from "@motion-mcp/llm";
import { probe } from "@motion-mcp/media";
import type { SceneWorker, SceneWorkResult } from "@motion-mcp/pi-runtime";
import type { QaSource } from "@motion-mcp/pipeline";
import { afterEach, describe, expect, it } from "vitest";
import { call, callOk, type Harness, startHarness, waitForJob } from "./harness.ts";

const SPEC_PATH = resolve(import.meta.dirname, "../../../fixtures/golden/product-launch/creative-spec.json");
const SPEC_JSON = readFileSync(SPEC_PATH, "utf8");
const creativeSpec = JSON.parse(SPEC_JSON) as Record<string, unknown>;
const BRIEF = "Launch video for Tracewise, a distributed tracing tool, for backend engineers.";

const doctor = await createHyperframesAdapter().doctor({ ensureBrowser: false });
const canRender = doctor.hyperframes.ok && doctor.chrome.ok && doctor.ffmpeg.ok;

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function download(h: Harness, url: string, name: string): Promise<string> {
  expect(url.startsWith("http")).toBe(true);
  const res = await fetch(h.local(url));
  expect(res.status).toBe(200);
  const file = join(h.dataDir, name);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

describe.skipIf(!canRender)("pipeline end to end (real HyperFrames render)", { timeout: 300_000 }, () => {
  it("host-opus: validated spec, zero model calls, preview and 1920x1080 final, publish", async () => {
    harness = await startHarness();
    const h = harness;
    const client = await h.connect();

    const caps = await callOk<Record<string, unknown>>(client, "motion_inspect", { target: "capabilities" });
    expect(caps.creativeSpecSchema).toBeTypeOf("object");
    expect(caps.scenePatchSchema).toBeTypeOf("object");
    expect(caps.promptGuidance).toBeTypeOf("string");

    const created = await callOk<{ projectId: string; jobId: string; status: string; directorMode: string }>(
      client,
      "motion_create",
      { brief: BRIEF, directorMode: "host-opus", creativeSpec, durationSeconds: 6, quality: "final" },
    );
    expect(created).toMatchObject({ status: "queued", directorMode: "host-opus" });

    const view = await waitForJob(client, created.projectId, created.jobId, ["succeeded"], 280_000, [
      "usage",
      "trace",
      "versions",
    ]);
    expect(view.project).toMatchObject({ status: "ready", currentVersion: 1 });
    expect(view.contactSheetUrl).toMatch(/^http:\/\/127\.0\.0\.1:8787\/artifacts\//);
    expect(JSON.stringify(view)).not.toContain(basename(h.dataDir));

    const preview = view.renders?.find((r) => r.quality === "preview" && r.status === "succeeded");
    const final = view.renders?.find((r) => r.quality === "final" && r.status === "succeeded");
    expect(preview?.url).toBeDefined();
    expect(final?.url).toBeDefined();

    const previewProbe = await probe(await download(h, preview?.url ?? "", "preview.mp4"));
    expect(previewProbe.width / previewProbe.height).toBeCloseTo(16 / 9, 1);
    expect(previewProbe.duration).toBeGreaterThan(5);
    expect(previewProbe.duration).toBeLessThan(7);
    const finalProbe = await probe(await download(h, final?.url ?? "", "final.mp4"));
    expect([finalProbe.width, finalProbe.height]).toEqual([1920, 1080]);

    // Host mode never bills a director; credits are captured for orchestration and renders only.
    const ops = view.usage?.breakdown.map((b) => b.operation) ?? [];
    expect(ops).toContain("orchestration_job");
    expect(ops).toContain("preview_render");
    expect(ops).toContain("render_minute_hd");
    expect(ops).not.toContain("creative_direction");
    expect(view.trace).toContain("video.create");
    const balance = await h.rt.ledger.balance("ws_default");
    expect(balance.available).toBe(500 - (view.usage?.credits ?? 0));
    expect(balance.held).toBe(0);

    const published = await callOk<{ url: string }>(client, "motion_publish", {
      projectId: created.projectId,
      renderId: final?.id,
      visibility: "unlisted",
    });
    expect(published.url).toBe(`http://127.0.0.1:8787/v/${final?.id}`);
    const ranged = await fetch(h.local(published.url), { headers: { Range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-type")).toBe("video/mp4");
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const search = await callOk<{ results: Array<{ id: string }>; exact: boolean }>(client, "motion_search", {
      query: "Tracewise launch",
    });
    expect(search.results[0]?.id).toBe(created.projectId);
    expect(search.exact).toBe(true);
  });

  it("internal-opus: exactly one director call and credits captured", async () => {
    const gateway = new ScriptedGateway([SPEC_JSON]);
    harness = await startHarness({ DEFAULT_DIRECTOR_MODE: "internal-opus" }, { gateway });
    const client = await harness.connect();
    const created = await callOk<{ projectId: string; jobId: string; directorMode: string }>(
      client,
      "motion_create",
      { brief: BRIEF, durationSeconds: 6 },
    );
    expect(created.directorMode).toBe("internal-opus");
    const view = await waitForJob(client, created.projectId, created.jobId, ["succeeded"], 200_000, [
      "usage",
    ]);
    expect(gateway.callCount).toBe(1);
    const ops = view.usage?.breakdown.map((b) => b.operation) ?? [];
    expect(ops).toContain("creative_direction");
    expect(view.usage?.credits).toBeGreaterThan(0);
    expect(view.usage?.costUsd).toBeGreaterThan(0);
    const balance = await harness.rt.ledger.balance("ws_default");
    expect(balance.available).toBe(500 - (view.usage?.credits ?? 0));
    expect(balance.held).toBe(0);
  });

  it("host-opus critique round trip: awaiting_host, then motion_edit with scenePatches resumes", async () => {
    let inspections = 0;
    const creativeOnce: QaSource = {
      name: "test-critic",
      async inspect() {
        inspections += 1;
        if (inspections > 1) return [];
        return [
          {
            id: "qa_test_creative",
            sceneId: "s02-problem",
            category: "creative",
            severity: "warn",
            message: "The metric lands without weight; the scene reads flat.",
            source: "vision",
          },
        ];
      },
    };
    harness = await startHarness({}, { qaSources: [creativeOnce] });
    const h = harness;
    const client = await h.connect();
    const created = await callOk<{ projectId: string; jobId: string }>(client, "motion_create", {
      brief: BRIEF,
      creativeSpec,
      durationSeconds: 6,
    });
    const paused = await waitForJob(client, created.projectId, created.jobId, ["awaiting_host"], 120_000);
    const request = paused.critiqueRequest as {
      requestId: string;
      sceneId: string;
      bundle: { contactSheet: string };
      responseSchema: unknown;
    };
    expect(request.requestId).toMatch(/^crq_/);
    expect(request.sceneId).toBe("s02-problem");
    expect(request.bundle.contactSheet).toMatch(/^http:\/\/127\.0\.0\.1:8787\/artifacts\//);
    expect(JSON.stringify(paused)).not.toContain(basename(h.dataDir));
    const sheet = await fetch(h.local(request.bundle.contactSheet));
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("content-type")).toBe("image/png");

    const stale = await call(client, "motion_edit", {
      projectId: created.projectId,
      critiqueRequestId: "crq_unknown",
      scenePatches: [{ sceneId: "s02-problem", changes: [{ type: "color", instruction: "x" }] }],
    });
    expect(stale.data).toMatchObject({ error: { code: "not_found" } });

    const edit = await callOk<{ jobId: string; version: number }>(client, "motion_edit", {
      projectId: created.projectId,
      critiqueRequestId: request.requestId,
      baseVersion: 1,
      scenePatches: [
        {
          sceneId: "s02-problem",
          changes: [
            {
              type: "typography",
              target: "metric",
              instruction: "Make the metric the hero",
              params: { size: "display" },
            },
          ],
          rationale: "Give the metric weight",
        },
      ],
    });
    expect(edit.version).toBe(2);
    const done = await waitForJob(client, created.projectId, edit.jobId, ["succeeded"], 200_000);
    expect(done.project.currentVersion).toBe(2);
    expect(done.renders?.some((r) => r.quality === "preview" && r.status === "succeeded")).toBe(true);

    const scene = await callOk<{ scene: { elements: Array<{ id: string; style: { size?: string } }> } }>(
      client,
      "motion_inspect",
      { target: "scene", projectId: created.projectId, sceneId: "s02-problem" },
    );
    expect(scene.scene.elements.find((e) => e.id === "metric")?.style.size).toBe("display");

    const conflict = await call(client, "motion_edit", {
      projectId: created.projectId,
      baseVersion: 1,
      scenePatches: [{ sceneId: "s02-problem", changes: [{ type: "color", instruction: "x" }] }],
    });
    expect(conflict.data).toMatchObject({ error: { code: "conflict" } });
  });

  it("falls back to the deterministic scene when worker output fails the runtime check", async () => {
    const built: string[] = [];
    /** A worker whose scene lints clean but fails at runtime, which only `hyperframes check` sees. */
    const brokenWorker: SceneWorker = {
      name: "broken-test-worker",
      async buildScene(input) {
        const file = join(input.projectDir, "compositions", `${input.sceneId}.html`);
        const html = await readFile(file, "utf8");
        // A font file that does not exist in the project: lint passes, the runtime check sees the 404.
        const broken = html.replace(
          /\n {2}<\/div>\n<\/template>\s*$/,
          [
            "",
            '    <style>@font-face { font-family: "Ghost Worker"; src: url("/assets/fonts/ghost-latin-400-normal.woff2"); }</style>',
            "    <div style=\"font-family: 'Ghost Worker'\">ghost</div>",
            "  </div>",
            "</template>",
            "",
          ].join("\n"),
        );
        expect(broken).not.toBe(html);
        await writeFile(file, broken, "utf8");
        built.push(input.sceneId);
        return {
          sceneId: input.sceneId,
          files: [`compositions/${input.sceneId}.html`],
          notes: "",
          runtime: "test",
          model: "none",
          durationMs: 0,
          counters: {} as SceneWorkResult["counters"],
        };
      },
      async patchScene() {
        throw new Error("patching is not part of this test");
      },
    };
    harness = await startHarness({ IMPLEMENTATION_MODE: "pi" }, { sceneWorker: brokenWorker });
    const client = await harness.connect();
    const created = await callOk<{ projectId: string; jobId: string }>(client, "motion_create", {
      brief: BRIEF,
      creativeSpec,
      durationSeconds: 6,
      quality: "final",
    });
    const view = await waitForJob(client, created.projectId, created.jobId, ["succeeded"], 280_000);
    expect(built.length).toBe(6);
    expect(view.job?.message).toContain("used the deterministic output");
    expect(view.renders?.some((r) => r.quality === "final" && r.status === "succeeded")).toBe(true);
    const project = await callOk<{ issues: Array<{ severity: string; source: string }> }>(
      client,
      "motion_inspect",
      { target: "project", projectId: created.projectId },
    );
    expect(project.issues.filter((i) => i.severity === "error" && i.source !== "vision")).toEqual([]);
  });
});

describe("pipeline service without rendering", () => {
  it("rejects a job the workspace cannot pay for with insufficient_credits", async () => {
    harness = await startHarness({ TRIAL_CREDITS: "0" });
    const client = await harness.connect();
    const res = await call(client, "motion_create", { brief: BRIEF, creativeSpec, durationSeconds: 6 });
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ error: { code: "insufficient_credits" } });
    const listed = await callOk<{ projects: unknown[] }>(client, "motion_list_projects", {});
    expect(listed.projects).toHaveLength(0);
  });

  it("rejects a job above budgetCredits before reserving", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    const res = await call(client, "motion_create", {
      brief: BRIEF,
      creativeSpec,
      durationSeconds: 6,
      budgetCredits: 1,
    });
    expect(res.data).toMatchObject({ error: { code: "budget_exceeded" } });
    expect((await harness.rt.ledger.balance("ws_default")).held).toBe(0);
  });

  it("host-opus without a spec and internal-opus without a gateway fail fast with guidance", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    const hostNoSpec = await call(client, "motion_create", { brief: BRIEF, directorMode: "host-opus" });
    expect(hostNoSpec.data).toMatchObject({ error: { code: "invalid_input" } });
    const internal = await call(client, "motion_create", { brief: BRIEF, directorMode: "internal-opus" });
    expect(internal.data).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("serves the styles index and 404s the Polar webhook when it is not configured", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    const styles = await callOk<{ styles: Array<{ id: string }> }>(client, "motion_inspect", {
      target: "styles",
    });
    expect(styles.styles.length).toBeGreaterThan(0);
    const hook = await fetch(new URL("/webhooks/polar", harness.base), { method: "POST", body: "{}" });
    expect(hook.status).toBe(404);
  });
});
