import { creditsToUsd, type Reservation } from "@motion-mcp/billing";
import type { Project } from "@motion-mcp/database";
import {
  buildHostCritiqueRequest,
  type DirectorMode,
  promptGuidance,
  type SceneCritiqueBundle,
  type SpecFormatRequest,
} from "@motion-mcp/director";
import { isRenderJustified, selectModel } from "@motion-mcp/jev-router";
import { chat } from "@motion-mcp/llm";
import {
  type AspectPreset,
  applyScenePatch,
  compileCreativeSpec,
  MotionIR,
  type QaIssue,
  ScenePatch,
  type TastePacket,
} from "@motion-mcp/motion-ir";
import { renderTree, startTrace, summarize } from "@motion-mcp/observability";
import { MotionError, newId, redact, redactDeep, toMotionError } from "@motion-mcp/shared";
import { z } from "zod";
import { UsageMeter } from "./billing-guard.ts";
import {
  applyWorkerPatches,
  compileVersion,
  finalRenderCredits,
  hasCompiledProject,
  implementCustomScenes,
  type JobScope,
  loadOverrides,
  loadVersionIr,
  type RevisionResult,
  renderVersion,
  reviseVersion,
  type SceneOverrides,
  storeVersionArtifacts,
  versionDir,
} from "./build-version.ts";
import type { CreateInput } from "./contract/tool-schemas.ts";
import { type CritiqueUsage, type JobResult, jobResult, updateJobResult } from "./job-record.ts";
import type { PipelineRuntime } from "./runtime.ts";

export type JobOutcome = "succeeded" | "awaiting_host";

/** Warnings (a skipped final render, reverted worker output) are part of the job's public message. */
function doneMessage(warnings: string[]): string {
  if (warnings.length === 0) return "Done";
  const text = `Done with ${warnings.length} warning(s): ${warnings.join("; ")}`;
  return redact(text.replace(LOCAL_PATH, "<path>")).slice(0, 500);
}

/** Absolute local paths (Windows drive or POSIX) that worker errors may carry; callers get no paths. */
const LOCAL_PATH = /(?:\b[A-Za-z]:[\\/]|(?<=^|[\s("'=])\/)[^\s"'()<>;,]+/g;

export interface JobMeta {
  jobId: string;
  projectId: string;
  workspaceId: string;
  kind: "create" | "edit" | "render";
  mode: DirectorMode;
  reservation: Reservation;
  /** Explicit budgetCredits, else the reservation size. */
  limitCredits: number;
  critiques?: CritiqueUsage;
}

/**
 * Job lifecycle around one graph run: running → body → capture credits → succeeded/awaiting_host, or
 * release credits → failed/cancelled. The trace is always persisted, redacted, with its cost summary.
 */
export async function executeJob(
  rt: PipelineRuntime,
  meta: JobMeta,
  signal: AbortSignal,
  body: (scope: JobScope) => Promise<JobOutcome>,
): Promise<JobOutcome | "failed" | "cancelled"> {
  const { repos, ledger, logger } = rt;
  const span = startTrace(`video.${meta.kind}`, {
    "job.id": meta.jobId,
    "project.id": meta.projectId,
    "workspace.id": meta.workspaceId,
    "director.mode": meta.mode,
  });
  const meter = new UsageMeter(meta.limitCredits);
  meter.add("orchestration_job", 1);
  const warnings: string[] = [];
  const critiques: CritiqueUsage = structuredClone(meta.critiques ?? { job: 0, scenes: {} });
  const scope: JobScope = {
    rt,
    sceneWorker: rt.sceneWorker,
    jobId: meta.jobId,
    workspaceId: meta.workspaceId,
    projectId: meta.projectId,
    mode: meta.mode,
    span,
    signal,
    meter,
    warnings,
    critiques,
    progress: async (stage, fraction, message = "") => {
      if (signal.aborted) return;
      await repos.jobs.update(meta.jobId, {
        progress: {
          stage,
          pct: Math.round(Math.min(1, Math.max(0, fraction)) * 100),
          message: message.slice(0, 500),
        },
      });
    },
  };

  let outcome: JobOutcome | "failed" | "cancelled";
  try {
    if (signal.aborted) throw new MotionError("CANCELLED", "Job cancelled before it started");
    await repos.jobs.update(meta.jobId, {
      status: "running",
      progress: { stage: "starting", pct: 1, message: "" },
    });
    try {
      scope.sceneWorker = await rt.providers.sceneWorkerFor(meta.workspaceId);
    } catch (err) {
      logger.warn("providers.worker_unavailable", { jobId: meta.jobId, message: toMotionError(err).message });
    }
    outcome = await body(scope);
    span.end();
    const summary = summarize(span.data);
    await ledger.capture({
      reservationId: meta.reservation.id,
      credits: meter.credits,
      operation: `job.${meta.kind}`,
      idempotencyKey: `job:${meta.jobId}:capture`,
      metadata: { jobId: meta.jobId },
    });
    for (const line of meter.lines) {
      await repos.usage.record({
        workspaceId: meta.workspaceId,
        projectId: meta.projectId,
        jobId: meta.jobId,
        operation: line.operation,
        quantity: line.quantity,
        credits: line.credits,
        byok: false,
      });
    }
    await updateJobResult(repos.jobs, meta.jobId, () => ({
      usage: meter.lines,
      capturedCredits: meter.credits,
      costUsd: Math.round(summary.cogsUsd * 1e6) / 1e6,
      warnings,
      critiques,
    }));
    await repos.jobs.update(meta.jobId, {
      status: outcome,
      progress:
        outcome === "succeeded"
          ? {
              stage: "done",
              pct: 100,
              message: doneMessage(warnings),
            }
          : { stage: "awaiting_host", pct: 50, message: "Waiting for the host's critique (motion_edit)" },
    });
  } catch (err) {
    span.fail(err);
    span.end();
    const e = toMotionError(err);
    outcome = e.code === "CANCELLED" || signal.aborted ? "cancelled" : "failed";
    await ledger
      .release({ reservationId: meta.reservation.id, idempotencyKey: `job:${meta.jobId}:release` })
      .catch((releaseErr: unknown) =>
        logger.error("billing.release_failed", {
          jobId: meta.jobId,
          message: toMotionError(releaseErr).message,
        }),
      );
    await updateJobResult(repos.jobs, meta.jobId, () => ({ warnings, usage: [] })).catch(() => undefined);
    await repos.jobs
      .update(meta.jobId, {
        status: outcome,
        error: { code: e.code, message: redact(e.message).slice(0, 2000), retryable: e.retryable },
        progress: { stage: outcome, pct: 100, message: "" },
      })
      .catch(() => undefined);
    await repos.projects
      .update(meta.projectId, (p) => ({
        status: meta.kind !== "create" && p.irVersion > 0 ? ("ready" as const) : ("failed" as const),
      }))
      .catch(() => undefined);
    logger.warn("job.failed", { jobId: meta.jobId, code: e.code, message: e.message, outcome });
  }

  try {
    await repos.traces.save({
      id: span.data.traceId,
      workspaceId: meta.workspaceId,
      projectId: meta.projectId,
      jobId: meta.jobId,
      name: span.data.name,
      root: redactDeep(span.data),
      summary: summarize(span.data),
      createdAt: new Date().toISOString(),
    });
    await repos.jobs.update(meta.jobId, { traceId: span.data.traceId });
  } catch (err) {
    logger.error("trace.persist_failed", { jobId: meta.jobId, message: toMotionError(err).message });
  }
  logger.info("job.finished", { jobId: meta.jobId, kind: meta.kind, outcome, trace: renderTree(span.data) });
  return outcome;
}

const ASPECTS: Record<AspectPreset, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };

/** Map the public format input onto the director's format request (aspect, fps, duration). */
export function formatRequest(
  format: CreateInput["format"],
  durationSeconds: number | undefined,
): SpecFormatRequest | undefined {
  let aspect = format?.aspectRatio;
  if (!aspect && format?.width && format.height) {
    const ratio = format.width / format.height;
    aspect = (Object.entries(ASPECTS) as Array<[AspectPreset, number]>).sort(
      (a, b) => Math.abs(a[1] - ratio) - Math.abs(b[1] - ratio),
    )[0]?.[0];
  }
  const out: SpecFormatRequest = {};
  if (aspect) out.aspect = aspect;
  if (format?.fps) out.fps = format.fps;
  if (durationSeconds) out.duration = durationSeconds;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Explicit width/height override the aspect preset's canvas (rounded to even pixels for H.264). */
function applyCanvas(ir: MotionIR, format: CreateInput["format"]): MotionIR {
  if (!format?.width || !format.height) return ir;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return MotionIR.parse({
    ...ir,
    format: { ...ir.format, width: even(format.width), height: even(format.height) },
  });
}

export interface DeliverInput {
  ir: MotionIR;
  version: number;
  overrides: SceneOverrides;
  taste: TastePacket;
  quality: "preview" | "final";
  /** Patch changes the IR could not express, implemented by the worker after compile. */
  workerPatches?: ScenePatch[];
}

/**
 * Shared tail of create and edit: compile → custom scenes → revision loop → store version → preview →
 * optional final. Pauses with `awaiting_host` when the loop needs a host critique.
 */
async function buildAndDeliver(scope: JobScope, input: DeliverInput): Promise<JobOutcome> {
  const { rt } = scope;
  const dir = versionDir(rt, scope.projectId, input.version);
  await scope.progress("compile", 0.12, `Compiling version ${input.version}`);
  await compileVersion(scope, input.ir, dir, input.overrides);
  await scope.progress("build", 0.18);
  await implementCustomScenes(scope, input.ir, dir, input.overrides);
  if (input.workerPatches?.length) {
    await applyWorkerPatches(scope, input.ir, dir, input.overrides, input.workerPatches);
  }

  const revised: RevisionResult = await reviseVersion(scope, {
    ir: input.ir,
    dir,
    overrides: input.overrides,
    taste: input.taste,
  });
  const { ir, inspection } = revised;
  const stored = await storeVersionArtifacts(scope, input.version, ir, input.overrides, inspection.sheet);
  await rt.repos.projects.update(scope.projectId, (p) => ({
    motionIR: ir,
    irVersion: input.version,
    artifacts: { ...p.artifacts, projectDir: dir, contactSheet: stored.contactSheetKey },
  }));
  await updateJobResult(rt.repos.jobs, scope.jobId, () => ({
    version: input.version,
    issues: inspection.issues.slice(0, 200),
    contactSheetKey: stored.contactSheetKey,
    frameKeys: stored.frameKeys,
    critiques: scope.critiques,
  }));

  if (revised.hostCritique) {
    const bundle = clientSafeBundle(revised.hostCritique.bundle, stored.framePathKeys);
    const request = buildHostCritiqueRequest(bundle);
    await updateJobResult(rt.repos.jobs, scope.jobId, () => ({
      critiqueRequest: request as unknown as Record<string, unknown>,
    }));
    scope.span.setAttributes({ "critique.host_request": request.requestId });
    return "awaiting_host";
  }

  await rt.repos.projects.update(scope.projectId, { status: "rendering" });
  const preview = await renderVersion(scope, {
    dir,
    ir,
    version: input.version,
    quality: "preview",
    renderId: newId("rnd"),
    range: [0.45, input.quality === "final" ? 0.7 : 0.97],
  });
  await rt.repos.projects.update(scope.projectId, (p) => ({
    artifacts: { ...p.artifacts, preview: preview.key },
  }));

  if (input.quality === "final") {
    const gate = isRenderJustified({
      kind: "final",
      lintErrors: inspection.lintErrors,
      checkErrors: inspection.checkErrors,
      openErrors: inspection.issues.filter(blocksFinal).length,
      changedSinceLastRender: true,
      budgetRemainingUsd: scope.meter.remainingUsd(),
      estimatedRenderCostUsd: creditsToUsd(finalRenderCredits(ir)),
    });
    if (gate.ok) {
      const final = await renderVersion(scope, {
        dir,
        ir,
        version: input.version,
        quality: "final",
        renderId: newId("rnd"),
        range: [0.7, 0.97],
      });
      await rt.repos.projects.update(scope.projectId, (p) => ({
        artifacts: { ...p.artifacts, final: final.key },
      }));
    } else {
      scope.warnings.push(`Final render skipped: ${gate.reason}`);
    }
  }
  await rt.repos.projects.update(scope.projectId, { status: "ready" });
  return "succeeded";
}

/**
 * Open errors that block a paid final render: deterministic findings (lint, check, timeline, render). Vision
 * and critique findings come from a model's judgment; they stay reported on the version but never veto a
 * final the caller asked for.
 */
function blocksFinal(issue: QaIssue): boolean {
  return issue.severity === "error" && issue.source !== "vision" && issue.source !== "critique";
}

/** Critique bundles leave the server with storage keys instead of local frame paths. */
function clientSafeBundle(bundle: SceneCritiqueBundle, keys: Map<string, string>): SceneCritiqueBundle {
  const map = (path: string | undefined) => (path ? keys.get(path) : undefined);
  const safe: SceneCritiqueBundle = { ...bundle, contactSheet: map(bundle.contactSheet) ?? "" };
  const prev = map(bundle.prevFrame);
  const next = map(bundle.nextFrame);
  if (prev) safe.prevFrame = prev;
  else delete safe.prevFrame;
  if (next) safe.nextFrame = next;
  else delete safe.nextFrame;
  return safe;
}

export interface CreateJobInput {
  brief: string;
  creativeSpec?: unknown;
  format?: CreateInput["format"];
  durationSeconds?: number;
  quality: "preview" | "final";
}

/** motion_create graph: director (host spec or internal Opus) → IR → build/QA/revise → renders. */
export async function runCreateJob(scope: JobScope, input: CreateJobInput): Promise<JobOutcome> {
  const { rt } = scope;
  await rt.repos.projects.update(scope.projectId, { status: "directing" });
  await scope.progress("direct", 0.04, scope.mode === "host-opus" ? "Validating creative spec" : "Directing");
  const format = formatRequest(input.format, input.durationSeconds);
  const domainContext =
    scope.mode === "host-opus"
      ? undefined
      : [
          rt.domainPack.styleIndexText({ maxChars: 1400 }),
          ...rt.domainPack
            .retrieve({
              role: "director",
              step: "direction",
              format: format?.aspect,
              limit: 7,
              maxChars: 2800,
            })
            .snippets.map((s) => s.text),
        ];
  const spec = await rt.director.createCreativeSpec(
    {
      brief: input.brief,
      format,
      mode: scope.mode,
      creativeSpec: input.creativeSpec,
      domainContext,
      signal: scope.signal,
    },
    scope.span,
  );
  if (spec.source === "model") scope.meter.add("creative_direction", 1);

  const ir = applyCanvas(
    compileCreativeSpec(spec.spec, { id: scope.projectId, duration: input.durationSeconds }),
    input.format,
  );
  scope.span.setAttributes({ "ir.scenes": ir.scenes.length, "ir.duration_s": ir.format.duration ?? 0 });
  await rt.repos.projects.update(scope.projectId, {
    title: (spec.spec.title ?? input.brief).slice(0, 120),
    tastePacket: spec.spec.tastePacket,
    creativeSpec: spec.spec,
    status: "building",
  });
  return buildAndDeliver(scope, {
    ir,
    version: 1,
    overrides: {},
    taste: spec.spec.tastePacket,
    quality: input.quality,
  });
}

const EDIT_SYSTEM_PROMPT = [
  "You turn a user's revision request for a motion-design video into ScenePatch objects.",
  "Change only what the request asks for. Target existing scene ids and element ids exactly.",
  "Prefer changes with params (deterministic); use instruction-only changes when no param can express it.",
  "",
  promptGuidance(),
  "",
  'Return JSON: { "patches": ScenePatch[] }. JSON only.',
].join("\n");

/** Free-text instruction → ScenePatch[] with one structured director-model call (internal modes only). */
export async function patchesFromInstruction(
  scope: JobScope,
  ir: MotionIR,
  instruction: string,
): Promise<ScenePatch[]> {
  const gateway = scope.rt.gateway;
  if (!gateway) throw new MotionError("CONFIG", "No model gateway configured for instruction edits");
  const scenes = new Map(ir.scenes.map((s) => [s.id, new Set(s.elements.map((e) => e.id))]));
  const EditPlan = z.object({ patches: z.array(ScenePatch).min(1).max(12) }).superRefine((plan, ctx) => {
    for (const [i, patch] of plan.patches.entries()) {
      const elements = scenes.get(patch.sceneId);
      if (!elements) {
        ctx.addIssue({ code: "custom", message: `unknown sceneId ${patch.sceneId}`, path: ["patches", i] });
        continue;
      }
      for (const [j, change] of patch.changes.entries()) {
        if (change.target && change.target !== "scene" && !elements.has(change.target)) {
          ctx.addIssue({
            code: "custom",
            message: `target ${change.target} is not an element of ${patch.sceneId}`,
            path: ["patches", i, "changes", j, "target"],
          });
        }
      }
    }
  });
  const summary = ir.scenes.map((s) => ({
    id: s.id,
    role: s.role,
    intent: s.intent,
    duration: s.duration,
    layout: s.layout.template,
    elements: s.elements,
    choreography: s.choreography,
    transitionOut: s.transitionOut.kind,
  }));
  const result = await scope.span.run("director.edit", (span) =>
    chat(gateway, {
      model: selectModel("polish", scope.rt.config),
      messages: [
        { role: "system", content: EDIT_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `Current scenes:\n${JSON.stringify(summary)}`, cache: true },
            { type: "text", text: `Revision request:\n${instruction}` },
          ],
        },
      ],
      responseSchema: { name: "scene_patches", schema: EditPlan },
      maxTokens: 2000,
      temperature: 0.3,
      cache: true,
      signal: scope.signal,
      span,
    }),
  );
  scope.meter.add("creative_critique", 1);
  return (result.parsed?.patches ?? []).map((p) => ({ ...p, source: "user" as const }));
}

export interface EditJobInput {
  project: Project;
  version: number;
  instruction?: string;
  scenePatches?: ScenePatch[];
  quality: "preview" | "final";
}

/** motion_edit graph: patches (given or from the instruction) → new version → build/QA/revise → renders. */
export async function runEditJob(scope: JobScope, input: EditJobInput): Promise<JobOutcome> {
  const { rt } = scope;
  const baseVersion = input.project.irVersion;
  let ir = MotionIR.parse(input.project.motionIR);
  await scope.progress("patch", 0.05, "Applying changes");
  const patches =
    input.scenePatches && input.scenePatches.length > 0
      ? input.scenePatches
      : await patchesFromInstruction(scope, ir, input.instruction ?? "");
  const workerPatches: ScenePatch[] = [];
  for (const patch of patches) {
    const applied = applyScenePatch(ir, patch);
    ir = applied.ir;
    if (applied.deferred.length > 0) workerPatches.push({ ...patch, changes: applied.deferred });
  }
  scope.span.setAttributes({ "edit.patches": patches.length, "edit.deferred": workerPatches.length });
  const taste = input.project.tastePacket ?? input.project.creativeSpec?.tastePacket;
  if (!taste) throw new MotionError("INTERNAL", "Project has no taste packet");
  await rt.repos.projects.update(scope.projectId, { status: "building" });
  return buildAndDeliver(scope, {
    ir,
    version: input.version,
    overrides: await loadOverrides(rt, scope, baseVersion),
    taste,
    quality: input.quality,
    workerPatches,
  });
}

export interface RenderJobInput {
  version: number;
  quality: "preview" | "final";
  renderId: string;
  currentVersion: number;
}

/** motion_render graph: stored IR (+ worker overrides) → compiled project → render → store. */
export async function runRenderJob(scope: JobScope, input: RenderJobInput): Promise<JobOutcome> {
  const { rt } = scope;
  const ir = await loadVersionIr(rt, scope, input.version);
  const dir = versionDir(rt, scope.projectId, input.version);
  if (!hasCompiledProject(dir)) {
    await scope.progress("compile", 0.1, `Recompiling version ${input.version}`);
    await compileVersion(scope, ir, dir, await loadOverrides(rt, scope, input.version));
  }
  const render = await renderVersion(scope, {
    dir,
    ir,
    version: input.version,
    quality: input.quality,
    renderId: input.renderId,
    range: [0.15, 0.97],
  });
  if (input.version === input.currentVersion) {
    await rt.repos.projects.update(scope.projectId, (p) => ({
      status: "ready",
      artifacts: { ...p.artifacts, [input.quality]: render.key },
    }));
  }
  return "succeeded";
}

/** Mark jobs that a previous process left queued or running as failed and release their credits. */
export async function recoverInterruptedJobs(rt: PipelineRuntime): Promise<number> {
  let recovered = 0;
  for (const status of ["queued", "running"] as const) {
    for (const job of await rt.repos.jobs.list({ status })) {
      if (rt.queue.isActive(job.id)) continue;
      const result: JobResult = jobResult(job);
      if (result.reservationId) {
        await rt.ledger
          .release({ reservationId: result.reservationId, idempotencyKey: `job:${job.id}:release` })
          .catch(() => undefined);
      }
      await rt.repos.jobs.update(job.id, {
        status: "failed",
        error: {
          code: "INTERRUPTED",
          message: "The server restarted while this job was running; run it again",
        },
        progress: { stage: "failed", pct: 100, message: "" },
      });
      recovered += 1;
    }
  }
  if (recovered > 0) rt.logger.warn("jobs.recovered", { count: recovered });
  return recovered;
}
