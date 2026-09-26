import { CREDIT_PRICES, CREDIT_USD, quoteJob } from "@motion-mcp/billing";
import type { Job, Project } from "@motion-mcp/database";
import {
  DirectorSpecSchema,
  HOST_OPUS_GUIDANCE,
  promptGuidance,
  resolveDirectorMode,
} from "@motion-mcp/director";
import { DEFAULT_CRITIQUE_LIMITS } from "@motion-mcp/jev-router";
import {
  AspectPreset,
  jsonSchemas,
  MOTION_IR_VERSION,
  MotionIR,
  type ScenePatch,
} from "@motion-mcp/motion-ir";
import { renderTree, type SpanData } from "@motion-mcp/observability";
import { MotionError, newId, redact } from "@motion-mcp/shared";
import { z } from "zod";
import { reserveForJob, TrialGrants } from "./billing-guard.ts";
import { loadVersionIr, versionDir } from "./build-version.ts";
import type { CallerContext, MotionService } from "./contract/motion-service.ts";
import type * as S from "./contract/tool-schemas.ts";
import { jobResult, type RenderRecord, updateJobResult } from "./job-record.ts";
import { executeJob, type JobMeta, runCreateJob, runEditJob, runRenderJob } from "./jobs.ts";
import type { PipelineRuntime } from "./runtime.ts";
import { domainPackDocs, projectDocs, searchDocs } from "./search.ts";

export const SERVER_VERSION = "0.1.0";

const POLL_HINT =
  "Poll motion_get_project with this projectId until job.state is succeeded, failed or awaiting_host.";

const DIRECTOR_MODES = [
  {
    mode: "host-opus",
    description:
      "You (the host model) are the creative director: author a CreativeSpec from creativeSpecSchema and " +
      "promptGuidance, pass it to motion_create, and answer critique requests with motion_edit scenePatches. " +
      "No server-side director is billed.",
    requires: ["creativeSpec"],
  },
  {
    mode: "internal-opus",
    description:
      "The server's own director model writes the CreativeSpec from your brief and critiques scenes.",
    requires: ["brief"],
  },
  {
    mode: "custom",
    description: "A workspace-configured planner model directs instead of the default director model.",
    requires: ["brief", "workspace custom model"],
  },
] as const;

const QUALITY_PRESETS = {
  preview: "Draft capture at up to 15 fps, downscaled to 540p. Fast; for review.",
  final: "Standard capture at native size and frame rate (1920x1080 for 16:9), CRF 18.",
};

/** Public job errors: domain codes pass through with their message; internal failures stay generic. */
const INTERNAL_CODES = new Set(["INTERNAL", "RENDER", "CONFIG", "INTERRUPTED"]);
function publicJobError(error: Job["error"]): { code: string; message: string } | undefined {
  if (!error) return undefined;
  if (error.code === "INTERRUPTED") return { code: "interrupted", message: error.message };
  if (INTERNAL_CODES.has(error.code))
    return { code: "internal", message: "The job failed; see the trace for details" };
  return { code: error.code.toLowerCase(), message: redact(error.message).slice(0, 600) };
}

const PublishedRender = z.object({
  renderId: z.string(),
  key: z.string(),
  visibility: z.enum(["unlisted", "public"]),
  workspaceId: z.string(),
  projectId: z.string(),
  publishedAt: z.string(),
});
export type PublishedRender = z.infer<typeof PublishedRender>;

const RENDER_ID = /^rnd_[0-9a-z]{10,40}$/;
const publishedKey = (renderId: string) => `public/${renderId}.json`;

/** Look up a published render for the public `/v/<renderId>` route. */
export async function resolvePublishedRender(
  rt: PipelineRuntime,
  renderId: string,
): Promise<PublishedRender | undefined> {
  if (!RENDER_ID.test(renderId)) return undefined;
  const key = publishedKey(renderId);
  if (!(await rt.store.exists(key))) return undefined;
  const parsed = PublishedRender.safeParse(JSON.parse((await rt.store.get(key)).toString("utf8")));
  return parsed.success ? parsed.data : undefined;
}

export interface PipelineMotionService extends MotionService {
  readonly runtime: PipelineRuntime;
}

/** The application service behind the eight public MCP tools. */
export function createMotionService(rt: PipelineRuntime): PipelineMotionService {
  const { repos, config } = rt;
  const trial = new TrialGrants(rt.ledger, config.TRIAL_CREDITS, rt.logger);
  /** Reservations cover the worst case (every allowed internal critique); capture bills only actual use. */
  const internalCritiqueCap = Math.min(DEFAULT_CRITIQUE_LIMITS.perJob, config.MAX_REVISION_LOOPS);

  async function ownedProject(caller: CallerContext, projectId: string): Promise<Project> {
    const project = await repos.projects.get(projectId).catch(() => undefined);
    if (!project || project.workspaceId !== caller.workspaceId) {
      throw new MotionError("NOT_FOUND", "Project not found");
    }
    return project;
  }

  async function latestJob(projectId: string): Promise<Job | undefined> {
    return (await repos.jobs.list({ projectId, limit: 1 }))[0];
  }

  async function assertIdle(projectId: string): Promise<Job | undefined> {
    const job = await latestJob(projectId);
    if (job && (job.status === "queued" || job.status === "running")) {
      throw new MotionError("CONFLICT", "A job is already running for this project", {
        details: { jobId: job.id },
      });
    }
    return job;
  }

  /** Schedule a job; the reservation is released if anything fails before the task owns it. */
  function schedule(meta: JobMeta, body: Parameters<typeof executeJob>[3]): void {
    rt.queue.enqueue(meta.jobId, async (signal) => {
      await executeJob(rt, meta, signal, body);
    });
  }

  async function withReservation<T>(reservationId: string, jobId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      await rt.ledger
        .release({ reservationId, idempotencyKey: `job:${jobId}:release` })
        .catch(() => undefined);
      throw err;
    }
  }

  const sign = (key: string | undefined) => (key ? rt.artifactUrl(key) : Promise.resolve(undefined));

  async function renderSummaries(jobs: Job[]): Promise<S.GetProjectOutput["renders"]> {
    const out: NonNullable<S.GetProjectOutput["renders"]> = [];
    for (const job of jobs) {
      for (const r of jobResult(job).renders) {
        out.push({
          id: r.id,
          quality: r.quality,
          status: r.status,
          url: r.status === "succeeded" ? await sign(r.key) : undefined,
          durationS: r.durationS,
          createdAt: r.createdAt,
        });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The job that produced a version (create/edit), for its QA findings and frames. */
  function producerOf(jobs: Job[], version: number): Job | undefined {
    return jobs.find((j) => {
      const r = jobResult(j);
      return r.version === version && r.source !== "render" && r.contactSheetKey !== undefined;
    });
  }

  async function clientCritiqueRequest(request: Record<string, unknown> | undefined) {
    if (!request) return undefined;
    const bundle = request.bundle as Record<string, unknown> | undefined;
    if (!bundle) return request;
    const resolved: Record<string, unknown> = { ...bundle };
    for (const field of ["contactSheet", "prevFrame", "nextFrame"]) {
      const key = bundle[field];
      if (typeof key === "string" && key) resolved[field] = await rt.artifactUrl(key);
    }
    return { ...request, bundle: resolved };
  }

  const service: PipelineMotionService = {
    runtime: rt,

    async create(caller, input) {
      const specProvided = input.creativeSpec !== undefined;
      const { mode } = resolveDirectorMode({
        requested: input.directorMode,
        creativeSpecProvided: specProvided,
        workspaceDefault: config.DEFAULT_DIRECTOR_MODE,
      });
      let specDuration: number | undefined;
      let specTitle: string | undefined;
      if (mode === "host-opus") {
        const parsed = DirectorSpecSchema.safeParse(input.creativeSpec);
        if (!parsed.success) {
          throw new MotionError("VALIDATION", `creativeSpec failed validation. ${HOST_OPUS_GUIDANCE}`, {
            details: { issues: parsed.error.issues.slice(0, 30) },
          });
        }
        specDuration = parsed.data.scenes.reduce((s, sc) => s + sc.duration, 0);
        specTitle = parsed.data.title;
      } else if (mode === "custom") {
        throw new MotionError(
          "VALIDATION",
          'directorMode "custom" needs a workspace planner model, which is not configured; use "host-opus" or "internal-opus"',
        );
      } else if (!rt.gateway) {
        throw new MotionError(
          "VALIDATION",
          `The internal director is not configured on this server. ${HOST_OPUS_GUIDANCE}`,
        );
      }
      await trial.ensure(caller.workspaceId);
      const quote = quoteJob({
        durationSeconds: input.durationSeconds ?? specDuration ?? 30,
        directorMode: mode,
        critiqueLoops: mode === "host-opus" ? 0 : internalCritiqueCap,
        previews: 1,
      });
      const projectId = newId("prj");
      const jobId = newId("job");
      const reservation = await reserveForJob(rt.ledger, {
        workspaceId: caller.workspaceId,
        jobId,
        quote,
        budgetCredits: input.budgetCredits,
      });
      await withReservation(reservation.id, jobId, async () => {
        await repos.projects.create({
          id: projectId,
          workspaceId: caller.workspaceId,
          title: (specTitle ?? input.brief).slice(0, 120),
          brief: input.brief,
          directorMode: mode,
          artifacts: { projectDir: versionDir(rt, projectId, 1) },
        });
        await repos.jobs.create({
          id: jobId,
          projectId,
          kind: "create",
          result: {
            source: "create",
            quality: input.quality,
            directorMode: mode,
            reservationId: reservation.id,
            quotedCredits: quote.totalCredits,
          },
        });
        schedule(
          {
            jobId,
            projectId,
            workspaceId: caller.workspaceId,
            kind: "create",
            mode,
            reservation,
            limitCredits: input.budgetCredits ?? reservation.credits,
          },
          (scope) =>
            runCreateJob(scope, {
              brief: input.brief,
              creativeSpec: input.creativeSpec,
              format: input.format,
              durationSeconds: input.durationSeconds,
              quality: input.quality,
            }),
        );
      });
      return { projectId, jobId, status: "queued", directorMode: mode, next: POLL_HINT };
    },

    async edit(caller, input) {
      const project = await ownedProject(caller, input.projectId);
      const previous = await assertIdle(project.id);
      if (!project.motionIR || project.irVersion < 1) {
        throw new MotionError("CONFLICT", "The project has no version to edit yet");
      }
      if (input.baseVersion !== undefined && input.baseVersion !== project.irVersion) {
        throw new MotionError(
          "CONFLICT",
          `baseVersion ${input.baseVersion} is stale; the current version is ${project.irVersion}`,
          { details: { currentVersion: project.irVersion } },
        );
      }
      const ir = MotionIR.parse(project.motionIR);
      const mode = input.directorMode ?? project.directorMode;
      const given = input.scenePatches ?? [];

      let critiques = { job: 0, scenes: {} as Record<string, number> };
      let answering: Job | undefined;
      if (input.critiqueRequestId) {
        const pending =
          previous?.status === "awaiting_host" ? jobResult(previous).critiqueRequest : undefined;
        if (!previous || !pending || pending.requestId !== input.critiqueRequestId) {
          throw new MotionError("NOT_FOUND", "Critique request not found or already answered");
        }
        if (given.length === 0) {
          throw new MotionError("VALIDATION", "Answer a critique request with scenePatches");
        }
        const sceneId = pending.sceneId;
        const foreign = given.find((p) => p.sceneId !== sceneId);
        if (foreign) {
          throw new MotionError(
            "VALIDATION",
            `This critique request covers scene "${String(sceneId)}" only`,
            {
              details: { sceneId: foreign.sceneId },
            },
          );
        }
        critiques = jobResult(previous).critiques;
        answering = previous;
      } else if (given.length === 0) {
        if (mode === "host-opus") {
          throw new MotionError(
            "VALIDATION",
            "In host-opus mode, author the change yourself: pass scenePatches (ScenePatch JSON Schema in " +
              'motion_inspect { target: "capabilities" }), or set directorMode "internal-opus" to have the server interpret the instruction.',
          );
        }
        if (!rt.gateway) {
          throw new MotionError(
            "VALIDATION",
            "Free-text instructions need the internal director, which is not configured on this server; pass scenePatches instead",
          );
        }
      }
      const sceneIds = new Set(ir.scenes.map((s) => s.id));
      const unknown = given.find((p) => !sceneIds.has(p.sceneId));
      if (unknown) throw new MotionError("VALIDATION", `Unknown sceneId "${unknown.sceneId}"`);
      const patches: ScenePatch[] = given.map((p) => ({ ...p, source: answering ? "host" : "user" }));

      await trial.ensure(caller.workspaceId);
      const quote = quoteJob({
        durationSeconds: ir.format.duration ?? 30,
        directorMode: "host-opus",
        critiqueLoops: (patches.length === 0 ? 1 : 0) + (mode === "host-opus" ? 0 : internalCritiqueCap),
        previews: 1,
      });
      const jobId = newId("job");
      const version = project.irVersion + 1;
      const reservation = await reserveForJob(rt.ledger, {
        workspaceId: caller.workspaceId,
        jobId,
        quote,
        budgetCredits: input.budgetCredits,
      });
      await withReservation(reservation.id, jobId, async () => {
        await repos.jobs.create({
          id: jobId,
          projectId: project.id,
          kind: "edit",
          result: {
            source: answering ? "critique" : "edit",
            quality: input.quality,
            directorMode: mode,
            reservationId: reservation.id,
            quotedCredits: quote.totalCredits,
          },
        });
        if (answering) {
          await updateJobResult(repos.jobs, answering.id, () => ({ continuedBy: jobId }));
          await repos.jobs.update(answering.id, {
            status: "succeeded",
            progress: { stage: "done", pct: 100, message: `Critique answered; continued in ${jobId}` },
          });
        }
        schedule(
          {
            jobId,
            projectId: project.id,
            workspaceId: caller.workspaceId,
            kind: "edit",
            mode,
            reservation,
            limitCredits: input.budgetCredits ?? reservation.credits,
            critiques,
          },
          (scope) =>
            runEditJob(scope, {
              project,
              version,
              instruction: input.instruction,
              scenePatches: patches,
              quality: input.quality,
            }),
        );
      });
      return { projectId: project.id, jobId, version, status: "queued", next: POLL_HINT };
    },

    async inspect(caller, input) {
      if (input.target === "capabilities") {
        const schemas = jsonSchemas();
        return {
          target: "capabilities",
          serverVersion: SERVER_VERSION,
          irVersion: MOTION_IR_VERSION,
          defaultDirectorMode: config.DEFAULT_DIRECTOR_MODE,
          internalDirectorAvailable: Boolean(rt.gateway),
          directorModes: DIRECTOR_MODES,
          creativeSpecSchema: schemas.creativeSpec,
          scenePatchSchema: schemas.scenePatch,
          promptGuidance: promptGuidance(),
          formats: { aspectRatios: AspectPreset.options, fps: { min: 12, max: 60 } },
          qualityPresets: QUALITY_PRESETS,
          pricing: {
            creditUsd: CREDIT_USD,
            operations: Object.fromEntries(
              Object.entries(CREDIT_PRICES).map(([op, p]) => [op, { credits: p.credits, unit: p.unit }]),
            ),
          },
          limits: {
            maxDurationSeconds: 180,
            maxScenes: 24,
            maxBriefChars: 8000,
            maxRevisionLoops: config.MAX_REVISION_LOOPS,
            concurrentJobsPerServer: config.JOB_CONCURRENCY,
            trialCredits: config.TRIAL_CREDITS,
          },
        };
      }
      if (input.target === "styles") {
        return {
          target: "styles",
          styles: rt.domainPack.styleIndex().map((s) => ({
            id: s.id,
            name: s.name,
            family: s.family,
            summary: s.summary,
            energy: s.energy,
            bestFor: s.bestFor,
          })),
        };
      }
      if (!input.projectId)
        throw new MotionError("VALIDATION", `target "${input.target}" requires projectId`);
      const project = await ownedProject(caller, input.projectId);
      if (project.irVersion < 1) throw new MotionError("NOT_FOUND", "The project has no version yet");
      const version = input.version ?? project.irVersion;
      if (version < 1 || version > project.irVersion)
        throw new MotionError("NOT_FOUND", `Version ${version} not found`);
      const ir =
        version === project.irVersion && project.motionIR
          ? MotionIR.parse(project.motionIR)
          : await loadVersionIr(rt, { workspaceId: caller.workspaceId, projectId: project.id }, version);
      const jobs = await repos.jobs.list({ projectId: project.id });
      const producer = producerOf(jobs, version);
      const produced = producer ? jobResult(producer) : undefined;
      const issues = produced?.issues ?? [];

      if (input.target === "project") {
        return {
          target: "project",
          projectId: project.id,
          version,
          motionIr: ir,
          issues,
          contactSheetUrl: await sign(produced?.contactSheetKey),
          renders: (await renderSummaries(jobs))?.filter((r) =>
            jobs.some((j) => jobResult(j).renders.some((x) => x.id === r.id && x.version === version)),
          ),
        };
      }
      if (!input.sceneId) throw new MotionError("VALIDATION", 'target "scene" requires sceneId');
      const scene = ir.scenes.find((s) => s.id === input.sceneId);
      if (!scene)
        throw new MotionError("NOT_FOUND", `Scene ${input.sceneId} not found in version ${version}`);
      const frameUrls: string[] = [];
      for (const key of produced?.frameKeys?.[scene.id] ?? []) frameUrls.push(await rt.artifactUrl(key));
      return {
        target: "scene",
        projectId: project.id,
        version,
        scene,
        issues: issues.filter((i) => i.sceneId === scene.id),
        frameUrls,
      };
    },

    async render(caller, input) {
      const project = await ownedProject(caller, input.projectId);
      await assertIdle(project.id);
      if (project.irVersion < 1)
        throw new MotionError("CONFLICT", "The project has no version to render yet");
      const version = input.version ?? project.irVersion;
      if (version < 1 || version > project.irVersion)
        throw new MotionError("NOT_FOUND", `Version ${version} not found`);
      const scope = { workspaceId: caller.workspaceId, projectId: project.id };
      const ir =
        version === project.irVersion && project.motionIR
          ? MotionIR.parse(project.motionIR)
          : await loadVersionIr(rt, scope, version);
      if (input.quality === "final") {
        const producer = producerOf(await repos.jobs.list({ projectId: project.id }), version);
        const blocking = (producer ? jobResult(producer).issues : []).filter(
          (i) => i.severity === "error" && (i.source === "lint" || i.source === "check"),
        );
        if (blocking.length > 0) {
          throw new MotionError(
            "VALIDATION",
            `A final render requires lint and check to pass; version ${version} has ${blocking.length} error(s). Edit the project first.`,
            { details: { issues: blocking.slice(0, 10) } },
          );
        }
      }
      await trial.ensure(caller.workspaceId);
      const quote = quoteJob({
        durationSeconds: ir.format.duration ?? 30,
        directorMode: "host-opus",
        critiqueLoops: 0,
        previews: input.quality === "preview" ? 1 : 0,
      });
      const jobId = newId("job");
      const renderId = newId("rnd");
      const reservation = await reserveForJob(rt.ledger, {
        workspaceId: caller.workspaceId,
        jobId,
        quote,
        budgetCredits: input.budgetCredits,
      });
      await withReservation(reservation.id, jobId, async () => {
        const render: RenderRecord = {
          id: renderId,
          quality: input.quality,
          status: "queued",
          version,
          visibility: "private",
          createdAt: new Date().toISOString(),
        };
        await repos.jobs.create({
          id: jobId,
          projectId: project.id,
          kind: "render",
          result: {
            source: "render",
            version,
            quality: input.quality,
            directorMode: project.directorMode,
            reservationId: reservation.id,
            quotedCredits: quote.totalCredits,
            renders: [render],
          },
        });
        schedule(
          {
            jobId,
            projectId: project.id,
            workspaceId: caller.workspaceId,
            kind: "render",
            mode: project.directorMode,
            reservation,
            limitCredits: input.budgetCredits ?? reservation.credits,
          },
          (s) =>
            runRenderJob(s, { version, quality: input.quality, renderId, currentVersion: project.irVersion }),
        );
      });
      return {
        projectId: project.id,
        renderId,
        jobId,
        status: "queued",
        estimatedCredits: quote.totalCredits,
        next: POLL_HINT,
      };
    },

    async search(caller, input) {
      const projects = await repos.projects.list({ workspaceId: caller.workspaceId, limit: 500 });
      return searchDocs([...projectDocs(projects), ...domainPackDocs(rt.domainPack)], input);
    },

    async getProject(caller, input) {
      const project = await ownedProject(caller, input.projectId);
      const include = new Set(input.include ?? []);
      const jobs = await repos.jobs.list({ projectId: project.id });
      const job = jobs[0];
      const result = job ? jobResult(job) : undefined;
      const out: S.GetProjectOutput = {
        project: {
          id: project.id,
          title: project.title,
          status: project.status,
          currentVersion: project.irVersion,
          directorMode: project.directorMode,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
        contactSheetUrl: await sign(project.artifacts.contactSheet),
        renders: await renderSummaries(jobs),
      };
      if (job) {
        out.job = {
          id: job.id,
          kind: job.kind,
          state: job.status,
          stage: job.progress.stage,
          progress: job.progress.pct / 100,
          message: job.progress.message || undefined,
          error: publicJobError(job.error),
        };
        if (job.status === "awaiting_host")
          out.critiqueRequest = await clientCritiqueRequest(result?.critiqueRequest);
      }
      if (include.has("versions")) {
        const seen = new Set<number>();
        out.versions = [];
        for (const j of [...jobs].reverse()) {
          const r = jobResult(j);
          if (r.version === undefined || r.source === "render" || !r.contactSheetKey || seen.has(r.version))
            continue;
          seen.add(r.version);
          out.versions.push({ version: r.version, createdAt: j.updatedAt, source: r.source ?? j.kind });
        }
      }
      if (include.has("usage")) {
        const events = (await repos.usage.list({ workspaceId: caller.workspaceId })).filter(
          (e) => e.projectId === project.id,
        );
        out.usage = {
          credits: events.reduce((s, e) => s + e.credits, 0),
          costUsd: Math.round(jobs.reduce((s, j) => s + (jobResult(j).costUsd ?? 0), 0) * 1e6) / 1e6,
          breakdown: events.map((e) => ({
            operation: e.operation,
            quantity: e.quantity,
            credits: e.credits,
            jobId: e.jobId,
            createdAt: e.createdAt,
          })),
        };
      }
      if (include.has("trace") && job?.traceId) {
        const trace = await repos.traces.get(job.traceId);
        if (trace) {
          out.trace = redact(
            `${renderTree(trace.root as SpanData)}\n\nsummary: ${JSON.stringify(trace.summary)}`,
          );
        }
      }
      if (include.has("ir") && project.motionIR)
        out.ir = project.motionIR as unknown as Record<string, unknown>;
      return out;
    },

    async listProjects(caller, input) {
      const all = (await repos.projects.list({ workspaceId: caller.workspaceId })).filter(
        (p) => input.status === undefined || p.status === input.status,
      );
      const offset = input.cursor
        ? Number.parseInt(Buffer.from(input.cursor, "base64url").toString(), 10)
        : 0;
      if (!Number.isInteger(offset) || offset < 0) throw new MotionError("VALIDATION", "Invalid cursor");
      const page = all.slice(offset, offset + input.limit);
      const projects = [];
      for (const p of page) {
        projects.push({
          id: p.id,
          title: p.title,
          status: p.status,
          updatedAt: p.updatedAt,
          thumbnailUrl: await sign(p.artifacts.contactSheet),
        });
      }
      const nextOffset = offset + page.length;
      return {
        projects,
        nextCursor:
          nextOffset < all.length ? Buffer.from(String(nextOffset)).toString("base64url") : undefined,
      };
    },

    async publish(caller, input) {
      const project = await ownedProject(caller, input.projectId);
      const jobs = await repos.jobs.list({ projectId: project.id });
      const owner = jobs.find((j) => jobResult(j).renders.some((r) => r.id === input.renderId));
      const render = owner ? jobResult(owner).renders.find((r) => r.id === input.renderId) : undefined;
      if (!owner || !render) throw new MotionError("NOT_FOUND", "Render not found");
      if (render.quality !== "final" || render.status !== "succeeded" || !render.key) {
        throw new MotionError("VALIDATION", "Only a succeeded final render can be published");
      }
      const record: PublishedRender = {
        renderId: render.id,
        key: render.key,
        visibility: input.visibility,
        workspaceId: caller.workspaceId,
        projectId: project.id,
        publishedAt: new Date().toISOString(),
      };
      await rt.store.put(publishedKey(render.id), Buffer.from(JSON.stringify(record)), "application/json");
      await updateJobResult(repos.jobs, owner.id, (cur) => ({
        renders: cur.renders.map((r) => (r.id === render.id ? { ...r, visibility: input.visibility } : r)),
      }));
      return {
        url: `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/v/${render.id}`,
        renderId: render.id,
        visibility: input.visibility,
      };
    },
  };
  return service;
}
