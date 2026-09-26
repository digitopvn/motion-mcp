import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { probe } from "@motion-mcp/media";
import { loadConfig, loadDotEnv, registerSecretsFromEnv } from "@motion-mcp/shared";
import { afterAll, describe, expect, it } from "vitest";
import { callOk, type Harness, startHarness, waitForJob } from "./harness.ts";

loadDotEnv(resolve(import.meta.dirname, "../../../.env"));
registerSecretsFromEnv();
const live = loadConfig();

/** Provider settings only; everything else comes from the harness (temp DATA_DIR, test keys). */
const providerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] =>
      typeof e[1] === "string" &&
      e[1] !== "" &&
      /^(OPENROUTER_|TYPESAFE_|DIRECTOR_MODEL|CODER_MODEL|DECISION_MODEL|VISION_MODEL|JEV_MODEL)/.test(e[0]),
  ),
);

const BRIEF =
  "Launch video for Tracewise, a distributed-tracing tool for backend teams. Message: debugging a checkout " +
  "request that touches 47 services stops being archaeology; one trace reads like a sentence. Audience: senior " +
  "backend engineers. Tone: calm, precise, editorial. End with 'Try Tracewise free' and tracewise.dev.";

let harness: Harness | undefined;
afterAll(async () => {
  await harness?.close();
});

describe.skipIf(!live.OPENROUTER_API_KEY)("pipeline (live OpenRouter, internal-opus)", () => {
  it("directs, builds, QA-checks and renders a final MP4, reporting cost", async () => {
    harness = await startHarness(
      {
        ...providerEnv,
        DEFAULT_DIRECTOR_MODE: "internal-opus",
        IMPLEMENTATION_MODE: "auto",
        TRIAL_CREDITS: "2000",
      },
      { gateway: undefined, sceneWorker: undefined, qaSources: undefined, decisions: undefined },
    );
    const h = harness;
    const client = await h.connect();
    const created = await callOk<{ projectId: string; jobId: string }>(client, "motion_create", {
      brief: BRIEF,
      durationSeconds: 15,
      quality: "final",
    });
    const view = await waitForJob(client, created.projectId, created.jobId, ["succeeded"], 1_500_000, [
      "usage",
      "trace",
    ]);
    const job = await h.rt.repos.jobs.get(created.jobId);
    const trace = await h.rt.repos.traces.get(job?.traceId ?? "missing");
    const issues = (job?.result?.issues ?? []) as Array<{
      severity: string;
      source: string;
      category: string;
    }>;
    // Only non-secret facts: job message, credits, COGS, model calls, tokens, open issues.
    console.log(
      JSON.stringify({
        job: view.job?.message,
        credits: view.usage?.credits,
        costUsd: view.usage?.costUsd,
        breakdown: view.usage?.breakdown.map((b) => [b.operation, b.quantity, b.credits]),
        trace: trace?.summary,
        issues: issues.map((i) => `${i.severity}:${i.source}:${i.category}`),
      }),
    );

    const final = view.renders?.find((r) => r.quality === "final" && r.status === "succeeded");
    expect(final?.url).toBeDefined();
    const res = await fetch(h.local(final?.url ?? ""));
    expect(res.status).toBe(200);
    const file = join(h.dataDir, "final.mp4");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const media = await probe(file);
    expect([media.width, media.height]).toEqual([1920, 1080]);
    console.log(
      JSON.stringify({ video: { width: media.width, height: media.height, duration: media.duration } }),
    );
  });
});
