import type { Job, JobRepo } from "@motion-mcp/database";
import { QaIssue } from "@motion-mcp/motion-ir";
import { z } from "zod";

/**
 * Pipeline-owned state stored in `Job.result`. The database treats it as an opaque JSON object, so it is
 * validated here on every read. Renders, versions, QA findings and pending host critique requests all live
 * on the job that produced them; project-level views aggregate across the project's jobs.
 */
export const RenderRecord = z.object({
  id: z.string(),
  quality: z.enum(["preview", "final"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  version: z.number().int().min(1),
  key: z.string().optional(),
  durationS: z.number().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  bytes: z.number().int().optional(),
  visibility: z.enum(["private", "unlisted", "public"]).default("private"),
  createdAt: z.string(),
});
export type RenderRecord = z.infer<typeof RenderRecord>;

export const CritiqueUsage = z.object({
  job: z.number().int().min(0).default(0),
  scenes: z.record(z.string(), z.number().int().min(0)).default({}),
});
export type CritiqueUsage = z.infer<typeof CritiqueUsage>;

export const UsageLine = z.object({
  operation: z.string(),
  quantity: z.number(),
  credits: z.number().int(),
});
export type UsageLine = z.infer<typeof UsageLine>;

export const JobResult = z.object({
  /** IR version this job produced (create/edit) or rendered (render). */
  version: z.number().int().min(0).optional(),
  source: z.enum(["create", "edit", "render", "critique"]).optional(),
  quality: z.enum(["preview", "final"]).default("preview"),
  directorMode: z.enum(["host-opus", "internal-opus", "custom"]).optional(),
  renders: z.array(RenderRecord).default([]),
  issues: z.array(QaIssue).default([]),
  contactSheetKey: z.string().optional(),
  frameKeys: z.record(z.string(), z.array(z.string())).optional(),
  critiqueRequest: z.record(z.string(), z.unknown()).optional(),
  critiques: CritiqueUsage.default({ job: 0, scenes: {} }),
  reservationId: z.string().optional(),
  quotedCredits: z.number().int().optional(),
  usage: z.array(UsageLine).default([]),
  capturedCredits: z.number().int().optional(),
  costUsd: z.number().optional(),
  warnings: z.array(z.string()).default([]),
  continuedBy: z.string().optional(),
});
export type JobResult = z.infer<typeof JobResult>;

export function jobResult(job: Pick<Job, "result">): JobResult {
  const parsed = JobResult.safeParse(job.result ?? {});
  return parsed.success ? parsed.data : JobResult.parse({});
}

/** Atomically merge into a job's result (read-modify-write under the repository lock). */
export function updateJobResult(
  jobs: JobRepo,
  jobId: string,
  mutate: (current: JobResult) => Partial<JobResult>,
): Promise<Job> {
  return jobs.update(jobId, (job) => {
    const current = jobResult(job);
    return { result: { ...current, ...mutate(current) } };
  });
}
