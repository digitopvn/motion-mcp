import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CREDIT_PRICES, priceOf } from "@motion-mcp/billing";
import { buildSceneCritiqueBundle, type DirectorMode, type SceneCritiqueBundle } from "@motion-mcp/director";
import type { ContactSheet } from "@motion-mcp/hyperframes-adapter";
import { classifyIssue, type IssueClassification, shouldEscalateToOpus } from "@motion-mcp/jev-router";
import {
  applyScenePatch,
  MotionIR,
  type MotionScene,
  type QaIssue,
  type ScenePatch,
  type TastePacket,
} from "@motion-mcp/motion-ir";
import type { Span } from "@motion-mcp/observability";
import type { SceneContext, SceneWorker } from "@motion-mcp/pi-runtime";
import { MotionError, toMotionError } from "@motion-mcp/shared";
import { artifactKey } from "@motion-mcp/storage";
import { z } from "zod";
import type { UsageMeter } from "./billing-guard.ts";
import { type CritiqueUsage, jobResult, type RenderRecord, updateJobResult } from "./job-record.ts";
import { mechanicalPatch } from "./qa.ts";
import type { PipelineRuntime } from "./runtime.ts";

/** Per-job execution scope shared by every node of the graph. */
export interface JobScope {
  rt: PipelineRuntime;
  /** This job's scene worker: the workspace's chosen pi model, else the server default. */
  sceneWorker?: SceneWorker;
  jobId: string;
  workspaceId: string;
  projectId: string;
  mode: DirectorMode;
  span: Span;
  signal: AbortSignal;
  meter: UsageMeter;
  warnings: string[];
  critiques: CritiqueUsage;
  progress(stage: string, fraction: number, message?: string): Promise<void>;
}

/**
 * Hand-written or Pi-built scene files that replace the deterministic compiler output. Each is pinned to
 * the exact scene IR it implements, so a later IR change to that scene invalidates it automatically.
 */
export const SceneOverrides = z.record(z.string(), z.object({ scene: z.string(), html: z.string() }));
export type SceneOverrides = z.infer<typeof SceneOverrides>;

export interface Inspection {
  issues: QaIssue[];
  lintErrors: number;
  checkErrors: number;
  sheet: ContactSheet;
}

export interface HostCritiqueNeeded {
  sceneId: string;
  bundle: SceneCritiqueBundle;
}

export const versionDir = (rt: PipelineRuntime, projectId: string, version: number) =>
  join(rt.workDir, projectId, `v${version}`);

export const versionKey = (
  scope: Pick<JobScope, "workspaceId" | "projectId">,
  version: number,
  name: string,
) =>
  artifactKey({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    kind: "compositions",
    name: `v${version}/${name}`,
  });

const snapshotKey = (scope: Pick<JobScope, "workspaceId" | "projectId">, version: number, name: string) =>
  artifactKey({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    kind: "snapshots",
    name: `v${version}/${name}`,
  });

const sceneFile = (dir: string, sceneId: string) => join(dir, "compositions", `${sceneId}.html`);
const sceneJson = (scene: MotionScene) => JSON.stringify(scene);
const errText = (err: unknown) => toMotionError(err).message;

export async function loadVersionIr(
  rt: PipelineRuntime,
  scope: Pick<JobScope, "workspaceId" | "projectId">,
  version: number,
): Promise<MotionIR> {
  const raw = await rt.store.get(versionKey(scope, version, "motion-ir.json")).catch((err: unknown) => {
    throw new MotionError("NOT_FOUND", `Version ${version} not found`, { cause: err });
  });
  return MotionIR.parse(JSON.parse(raw.toString("utf8")));
}

export async function loadOverrides(
  rt: PipelineRuntime,
  scope: Pick<JobScope, "workspaceId" | "projectId">,
  version: number,
): Promise<SceneOverrides> {
  const key = versionKey(scope, version, "scene-overrides.json");
  if (!(await rt.store.exists(key))) return {};
  const parsed = SceneOverrides.safeParse(JSON.parse((await rt.store.get(key)).toString("utf8")));
  return parsed.success ? parsed.data : {};
}

/** Deterministic compile of every scene, then re-apply overrides whose scene IR is unchanged. */
export async function compileVersion(
  scope: Pick<JobScope, "rt" | "span">,
  ir: MotionIR,
  dir: string,
  overrides: SceneOverrides,
): Promise<void> {
  await scope.span.run("scenes.build", async (span) => {
    await rm(dir, { recursive: true, force: true });
    const compiled = await scope.rt.renderer.compile(ir, dir);
    let restored = 0;
    for (const scene of ir.scenes) {
      const override = overrides[scene.id];
      if (!override) continue;
      if (override.scene !== sceneJson(scene)) {
        delete overrides[scene.id];
        continue;
      }
      await writeFile(sceneFile(dir, scene.id), override.html, "utf8");
      restored += 1;
    }
    span.setAttributes({
      "compile.scenes": ir.scenes.length,
      "compile.overrides": restored,
      "compile.warnings": compiled.warnings.length,
      "compile.duration_s": compiled.duration,
    });
  });
}

function sceneContext(ir: MotionIR): SceneContext {
  return { format: ir.format, brand: ir.brand, motionLanguage: ir.motionLanguage };
}

function workerSkills(rt: PipelineRuntime, scene: MotionScene): string[] {
  return rt.domainPack
    .retrieve({ role: "worker", sceneRole: scene.role, step: "compose", maxChars: 2500 })
    .snippets.map((s) => s.text);
}

/**
 * Run the scene worker on one scene (build from IR, or patch the existing file). The result is kept only
 * when it lints clean for that scene; otherwise the deterministic file is restored.
 */
async function runSceneWorker(
  scope: JobScope,
  ir: MotionIR,
  dir: string,
  overrides: SceneOverrides,
  task: { sceneId: string; kind: "build" | "patch"; patch?: ScenePatch; issues?: QaIssue[] },
): Promise<boolean> {
  const worker = scope.sceneWorker;
  const scene = ir.scenes.find((s) => s.id === task.sceneId);
  if (!worker || !scene) return false;
  const file = sceneFile(dir, scene.id);
  const before = await readFile(file, "utf8");
  try {
    const common = {
      projectDir: dir,
      sceneId: scene.id,
      context: sceneContext(ir),
      skills: workerSkills(scope.rt, scene),
      span: scope.span,
      signal: scope.signal,
    };
    if (task.kind === "build") await worker.buildScene({ ...common, sceneIR: scene });
    else await worker.patchScene({ ...common, sceneIR: scene, patch: task.patch, qaIssues: task.issues });
    const lint = await scope.rt.renderer.lint(dir);
    const broken = lint.issues.filter((i) => i.sceneId === scene.id && i.severity === "error");
    if (broken.length > 0) throw new MotionError("LINT", `worker output has ${broken.length} lint errors`);
    overrides[scene.id] = { scene: sceneJson(scene), html: await readFile(file, "utf8") };
    return true;
  } catch (err) {
    if (scope.signal.aborted) throw err;
    await writeFile(file, before, "utf8");
    scope.warnings.push(
      `Scene ${scene.id}: ${task.kind === "build" ? "custom build" : "worker patch"} failed (${errText(err)}); kept the deterministic output`,
    );
    scope.rt.logger.warn("scene.worker.failed", {
      jobId: scope.jobId,
      sceneId: scene.id,
      message: errText(err),
    });
    return false;
  }
}

/** Scenes the Pi worker implements, per IMPLEMENTATION_MODE: none, `custom` scenes (auto), or all (pi). */
export async function implementCustomScenes(
  scope: JobScope,
  ir: MotionIR,
  dir: string,
  overrides: SceneOverrides,
): Promise<void> {
  const mode = scope.rt.config.IMPLEMENTATION_MODE;
  if (mode === "deterministic") return;
  const targets = ir.scenes.filter(
    (s) => (mode === "pi" || s.implementation === "custom") && overrides[s.id]?.scene !== sceneJson(s),
  );
  if (targets.length === 0) return;
  if (!scope.sceneWorker) {
    scope.warnings.push(
      `${targets.length} custom scene(s) used the deterministic compiler (no scene worker configured)`,
    );
    return;
  }
  for (const scene of targets) {
    await runSceneWorker(scope, ir, dir, overrides, { sceneId: scene.id, kind: "build" });
  }
}

/** Apply ScenePatches that need code-level work (deferred changes) with the worker, when there is one. */
export async function applyWorkerPatches(
  scope: JobScope,
  ir: MotionIR,
  dir: string,
  overrides: SceneOverrides,
  patches: ScenePatch[],
): Promise<void> {
  for (const patch of patches) {
    if (!scope.sceneWorker) {
      scope.warnings.push(
        `Scene ${patch.sceneId}: ${patch.changes.length} change(s) need a code-level edit and no scene worker is configured`,
      );
      continue;
    }
    await runSceneWorker(scope, ir, dir, overrides, { sceneId: patch.sceneId, kind: "patch", patch });
  }
}

export async function inspectVersion(
  scope: JobScope,
  ir: MotionIR,
  dir: string,
  loop: number,
): Promise<Inspection> {
  const { rt, span, signal } = scope;
  const lint = await span.run("hyperframes.lint", async (s) => {
    const report = await rt.renderer.lint(dir);
    s.setAttributes({ "lint.errors": report.counts.errors, "lint.warnings": report.counts.warnings });
    return report;
  });
  const check = await span.run("hyperframes.check", async (s) => {
    const report = await rt.renderer.check(dir, { signal });
    s.setAttributes({ "check.errors": report.counts.errors, "check.warnings": report.counts.warnings });
    return report;
  });
  const sheet = await span.run("snapshot.contact_sheet", () => rt.renderer.contactSheet(dir, { signal }));
  const extra: QaIssue[] = [];
  for (const source of rt.qaSources) {
    extra.push(
      ...(await source.inspect({ ir, projectDir: dir, contactSheetPath: sheet.path, loop, span, signal })),
    );
  }
  return {
    issues: [...lint.issues, ...check.issues, ...extra],
    lintErrors: lint.counts.errors,
    checkErrors: check.counts.errors,
    sheet,
  };
}

/** Issues worth acting on: every error, plus creative warnings (which only judgment can resolve). */
function actionable(issues: QaIssue[]): QaIssue[] {
  return issues.filter((i) => i.severity === "error" || (i.severity === "warn" && i.category === "creative"));
}

const issueKey = (i: QaIssue) => `${i.category}|${i.sceneId ?? ""}|${i.evidence?.selector ?? ""}`;

function sceneFrames(sheet: ContactSheet, ir: MotionIR, sceneId: string) {
  const index = ir.scenes.findIndex((s) => s.id === sceneId);
  const own = sheet.frames.filter((f) => f.sceneId === sceneId);
  const prevId = ir.scenes[index - 1]?.id;
  const nextId = ir.scenes[index + 1]?.id;
  return {
    contactSheet: own[Math.floor(own.length / 2)]?.path ?? sheet.path,
    prevFrame: prevId ? sheet.frames.filter((f) => f.sceneId === prevId).at(-1)?.path : undefined,
    nextFrame: nextId ? sheet.frames.find((f) => f.sceneId === nextId)?.path : undefined,
  };
}

export interface RevisionResult {
  ir: MotionIR;
  inspection: Inspection;
  hostCritique?: HostCritiqueNeeded;
}

/** Deterministic findings that make a version unfit for a final render. */
function isBlocking(issue: QaIssue): boolean {
  return issue.severity === "error" && (issue.source === "lint" || issue.source === "check");
}

/**
 * Safety net for worker output: lint runs per worker call, but runtime failures (missing fonts or assets)
 * only surface in the full check. Worker scenes implicated in lint/check errors fall back to the
 * deterministic compiler, whose output is known to render, before any issue is classified or escalated.
 * The check does not attribute every finding to every scene that causes it (repeated findings collapse),
 * so a second pass reverts all remaining worker scenes when blocking errors persist: the deterministic
 * project is the known-good baseline.
 */
async function revertBrokenWorkerScenes(
  scope: JobScope,
  ir: MotionIR,
  dir: string,
  overrides: SceneOverrides,
  inspection: Inspection,
  loop: number,
): Promise<Inspection> {
  let current = inspection;
  const reverted: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const blocking = current.issues.filter(isBlocking);
    const workerScenes = Object.keys(overrides);
    if (blocking.length === 0 || workerScenes.length === 0) break;
    const everything = pass > 0 || blocking.some((i) => !i.sceneId);
    const revert = workerScenes.filter((id) => everything || blocking.some((i) => i.sceneId === id));
    if (revert.length === 0) break;
    for (const id of revert) delete overrides[id];
    reverted.push(...revert);
    await compileVersion(scope, ir, dir, overrides);
    current = await inspectVersion(scope, ir, dir, loop);
  }
  if (reverted.length > 0) {
    scope.warnings.push(
      `${reverted.length} worker-built scene(s) failed lint/check (${reverted.join(", ")}); used the deterministic output`,
    );
    scope.span.setAttributes({ "worker.reverted": reverted.join(",") });
  }
  return current;
}

/**
 * The bounded revision loop: inspect → classify every actionable issue with Jev → cheap fixes (IR patch
 * or worker patch) → creative critique when the policy allows (internal director call, or a host critique
 * request that pauses the job) → recompile → re-inspect. Stops at MAX_REVISION_LOOPS or when nothing
 * more can be changed; the last inspection always describes the returned IR.
 */
export async function reviseVersion(
  scope: JobScope,
  input: { ir: MotionIR; dir: string; overrides: SceneOverrides; taste: TastePacket },
): Promise<RevisionResult> {
  const { rt } = scope;
  const maxLoops = rt.config.MAX_REVISION_LOOPS;
  const attempts = new Map<string, number>();
  let ir = input.ir;
  for (let loop = 0; ; loop++) {
    await scope.progress("qa", Math.min(0.4, 0.25 + loop * 0.05), `QA pass ${loop + 1}`);
    const inspection = await revertBrokenWorkerScenes(
      scope,
      ir,
      input.dir,
      input.overrides,
      await inspectVersion(scope, ir, input.dir, loop),
      loop,
    );
    const open = actionable(inspection.issues);
    if (open.length === 0 || loop >= maxLoops) return { ir, inspection };

    const classified: Array<{ issue: QaIssue; cls: IssueClassification }> = [];
    for (const issue of open) {
      const scene = ir.scenes.find((s) => s.id === issue.sceneId);
      const cls = await classifyIssue(
        issue,
        { directorMode: scope.mode, sceneRole: scene?.role, attempts: attempts.get(issueKey(issue)) ?? 0 },
        { decisions: rt.decisions, span: scope.span },
      );
      classified.push({ issue, cls });
    }

    let irChanged = false;
    const workerPatches: ScenePatch[] = [];
    const workerIssues = new Map<string, QaIssue[]>();

    for (const { issue, cls } of classified) {
      if (!cls.cheapFixable || cls.needsOpus || cls.worker !== "pi" || !issue.sceneId) continue;
      attempts.set(issueKey(issue), (attempts.get(issueKey(issue)) ?? 0) + 1);
      const scene = ir.scenes.find((s) => s.id === issue.sceneId);
      const patch = scene ? mechanicalPatch(issue, scene) : undefined;
      if (patch) {
        const applied = applyScenePatch(ir, patch);
        if (applied.applied.length > 0) {
          ir = applied.ir;
          irChanged = true;
          continue;
        }
      }
      workerIssues.set(issue.sceneId, [...(workerIssues.get(issue.sceneId) ?? []), issue]);
    }

    const creativeScenes = new Map<string, IssueClassification[]>();
    for (const { issue, cls } of classified) {
      if (!cls.needsOpus || !issue.sceneId) continue;
      creativeScenes.set(issue.sceneId, [...(creativeScenes.get(issue.sceneId) ?? []), cls]);
    }
    for (const [sceneId, issues] of creativeScenes) {
      const verdict = shouldEscalateToOpus({
        issues,
        loop,
        budgetRemainingUsd: scope.meter.remainingUsd(),
        mode: scope.mode,
        critiqueModel: rt.config.DIRECTOR_MODEL,
        critiquesForScene: scope.critiques.scenes[sceneId] ?? 0,
        critiquesForJob: scope.critiques.job,
        limits: { maxLoops },
      });
      scope.span.setAttributes({
        [`critique.${sceneId}`]: `${verdict.ok ? "yes" : "no"}: ${verdict.reason}`,
      });
      if (!verdict.ok) continue;
      const bundle = buildSceneCritiqueBundle(
        ir,
        sceneId,
        { ...sceneFrames(inspection.sheet, ir, sceneId), qaIssues: open },
        input.taste,
      );
      scope.critiques.job += 1;
      scope.critiques.scenes[sceneId] = (scope.critiques.scenes[sceneId] ?? 0) + 1;
      if (scope.mode === "host-opus") return { ir, inspection, hostCritique: { sceneId, bundle } };
      try {
        const critique = await rt.director.critiqueScene(bundle, scope.span, {
          mode: scope.mode,
          signal: scope.signal,
        });
        scope.meter.add("creative_critique", 1);
        const applied = applyScenePatch(ir, critique.patch);
        if (applied.applied.length > 0) {
          ir = applied.ir;
          irChanged = true;
        }
        if (applied.deferred.length > 0) workerPatches.push({ ...critique.patch, changes: applied.deferred });
      } catch (err) {
        if (scope.signal.aborted) throw err;
        scope.warnings.push(`Critique of ${sceneId} failed: ${errText(err)}`);
      }
    }

    if (irChanged) await compileVersion(scope, ir, input.dir, input.overrides);
    let workerChanged = false;
    if (scope.sceneWorker) {
      for (const [sceneId, issues] of workerIssues) {
        workerChanged =
          (await runSceneWorker(scope, ir, input.dir, input.overrides, { sceneId, kind: "patch", issues })) ||
          workerChanged;
      }
    }
    if (workerPatches.length > 0) {
      await applyWorkerPatches(scope, ir, input.dir, input.overrides, workerPatches);
      workerChanged = true;
    }
    if (!irChanged && !workerChanged) return { ir, inspection };
  }
}

export interface StoredVersion {
  contactSheetKey: string;
  frameKeys: Record<string, string[]>;
  /** Local frame path → storage key, for turning critique bundles into client-safe references. */
  framePathKeys: Map<string, string>;
}

/** Persist the version's IR, worker overrides, contact sheet and per-scene frames. */
export async function storeVersionArtifacts(
  scope: JobScope,
  version: number,
  ir: MotionIR,
  overrides: SceneOverrides,
  sheet: ContactSheet,
): Promise<StoredVersion> {
  const { store } = scope.rt;
  return scope.span.run("artifacts.store", async (span) => {
    await store.put(
      versionKey(scope, version, "motion-ir.json"),
      Buffer.from(JSON.stringify(ir, null, 2)),
      "application/json",
    );
    if (Object.keys(overrides).length > 0) {
      await store.put(
        versionKey(scope, version, "scene-overrides.json"),
        Buffer.from(JSON.stringify(overrides)),
        "application/json",
      );
    }
    const contactSheetKey = snapshotKey(scope, version, "contact-sheet.png");
    await store.put(contactSheetKey, { path: sheet.path }, "image/png");
    const frameKeys: Record<string, string[]> = {};
    const framePathKeys = new Map<string, string>();
    for (const frame of sheet.frames) {
      const list = frameKeys[frame.sceneId] ?? [];
      frameKeys[frame.sceneId] = list;
      const key = snapshotKey(scope, version, `frames/${frame.sceneId}-${list.length}.png`);
      await store.put(key, { path: frame.path }, "image/png");
      list.push(key);
      framePathKeys.set(frame.path, key);
    }
    framePathKeys.set(sheet.path, contactSheetKey);
    span.setAttributes({ "artifacts.frames": sheet.frames.length });
    return { contactSheetKey, frameKeys, framePathKeys };
  });
}

/** Render one quality of a compiled version, store the MP4 and update the job's render record. */
export async function renderVersion(
  scope: JobScope,
  input: {
    dir: string;
    ir: MotionIR;
    version: number;
    quality: "preview" | "final";
    renderId: string;
    range: [number, number];
  },
): Promise<RenderRecord> {
  const { rt } = scope;
  const [from, to] = input.range;
  const setRender = (patch: Partial<RenderRecord>) =>
    updateJobResult(rt.repos.jobs, scope.jobId, (cur) => {
      const existing = cur.renders.find((r) => r.id === input.renderId);
      const base: RenderRecord = existing ?? {
        id: input.renderId,
        quality: input.quality,
        status: "queued",
        version: input.version,
        visibility: "private",
        createdAt: new Date().toISOString(),
      };
      const next = { ...base, ...patch };
      return { renders: [...cur.renders.filter((r) => r.id !== input.renderId), next] };
    });

  await setRender({ status: "running" });
  await scope.progress(`render.${input.quality}`, from, `Rendering ${input.quality}`);
  return scope.span.run(
    `${input.quality}.render`,
    async (span) => {
      const outputPath = join(input.dir, "renders", `${input.renderId}.mp4`);
      await mkdir(join(input.dir, "renders"), { recursive: true });
      let lastPct = -1;
      try {
        const result = await rt.renderer.render(input.dir, {
          preset: input.quality,
          outputPath,
          signal: scope.signal,
          logger: rt.logger,
          onProgress: (p) => {
            const pct = Math.round((from + (to - from) * p.progress) * 100);
            if (pct - lastPct >= 3) {
              lastPct = pct;
              void scope.progress(`render.${input.quality}`, pct / 100, p.stage).catch(() => undefined);
            }
          },
        });
        const minutes = result.probe.duration / 60;
        span.addCost(
          "render",
          input.quality === "preview"
            ? CREDIT_PRICES.preview_render.estCostUsd
            : minutes * CREDIT_PRICES.render_minute_hd.estCostUsd,
        );
        span.setAttributes({
          "render.ms": result.durationMs,
          "render.renderer": result.renderer,
          "render.width": result.probe.width ?? 0,
          "render.height": result.probe.height ?? 0,
        });
        const key = artifactKey({
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "renders",
          name: `${input.renderId}.mp4`,
        });
        const put = await rt.store.put(key, { path: outputPath }, "video/mp4");
        if (input.quality === "preview") scope.meter.add("preview_render", 1);
        else scope.meter.add("render_minute_hd", minutes);
        await setRender({
          status: "succeeded",
          key,
          durationS: result.probe.duration,
          width: result.probe.width,
          height: result.probe.height,
          bytes: put.size,
        });
        const job = await setRender({});
        const record = jobResult(job).renders.find((r) => r.id === input.renderId);
        if (!record) throw new MotionError("INTERNAL", "render record vanished");
        return record;
      } catch (err) {
        await setRender({ status: scope.signal.aborted ? "cancelled" : "failed" }).catch(() => undefined);
        throw err;
      }
    },
    { "render.quality": input.quality, "render.id": input.renderId },
  );
}

/** Estimated credits for a final render of this IR (used by the render gate). */
export function finalRenderCredits(ir: MotionIR): number {
  return priceOf("render_minute_hd", (ir.format.duration ?? 0) / 60);
}

export function hasCompiledProject(dir: string): boolean {
  return existsSync(join(dir, "index.html"));
}
