import type { CreativeSpec, MotionIR, TastePacket } from "@motion-mcp/motion-ir";
import type { SpanData, TraceSummary } from "@motion-mcp/observability";
import { z } from "zod";

/**
 * Persisted entities. Large JSON payloads (taste packet, creative spec, IR, trace tree) are validated by
 * their owning packages before they are stored; here they are only checked to be objects.
 */
const jsonObject = <T>() =>
  z.custom<T>((v) => typeof v === "object" && v !== null && !Array.isArray(v), "expected a JSON object");

export const RecordId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "invalid id");
const Timestamp = z.iso.datetime();

export const DirectorMode = z.enum(["host-opus", "internal-opus", "custom"]);
export type DirectorMode = z.infer<typeof DirectorMode>;

export const ProjectStatus = z.enum(["draft", "directing", "building", "rendering", "ready", "failed"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ProjectArtifacts = z.object({
  preview: z.string().optional(),
  final: z.string().optional(),
  contactSheet: z.string().optional(),
  projectDir: z.string(),
});
export type ProjectArtifacts = z.infer<typeof ProjectArtifacts>;

export const Project = z.object({
  id: RecordId,
  workspaceId: RecordId,
  title: z.string().max(200),
  brief: z.string().max(20_000),
  directorMode: DirectorMode,
  status: ProjectStatus,
  tastePacket: jsonObject<TastePacket>().optional(),
  creativeSpec: jsonObject<CreativeSpec>().optional(),
  motionIR: jsonObject<MotionIR>().optional(),
  /** Monotonic count of IR revisions (0 until the first IR exists). */
  irVersion: z.number().int().min(0),
  artifacts: ProjectArtifacts,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const JobKind = z.enum(["create", "edit", "render"]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "awaiting_host"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobProgress = z.object({
  stage: z.string().max(64),
  pct: z.number().min(0).max(100),
  message: z.string().max(500).default(""),
});
export type JobProgress = z.infer<typeof JobProgress>;

export const JobError = z.object({
  code: z.string().max(64),
  message: z.string().max(2000),
  retryable: z.boolean().optional(),
});
export type JobError = z.infer<typeof JobError>;

export const Job = z.object({
  id: RecordId,
  projectId: RecordId,
  kind: JobKind,
  status: JobStatus,
  progress: JobProgress,
  error: JobError.optional(),
  result: jsonObject<Record<string, unknown>>().optional(),
  traceId: z.string().max(80).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Job = z.infer<typeof Job>;

export const ApiKey = z.object({
  id: RecordId,
  workspaceId: RecordId,
  name: z.string().min(1).max(120),
  /** sha256 hex of the full key; the plaintext is never stored. */
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Non-secret display prefix, e.g. `mmcp_Ab12Cd3`. */
  prefix: z.string().max(16),
  createdAt: Timestamp,
  revokedAt: Timestamp.optional(),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const TraceRecord = z.object({
  id: RecordId,
  workspaceId: RecordId.optional(),
  projectId: RecordId.optional(),
  jobId: RecordId.optional(),
  name: z.string().max(200),
  root: jsonObject<SpanData>(),
  summary: jsonObject<TraceSummary>(),
  createdAt: Timestamp,
});
export type TraceRecord = z.infer<typeof TraceRecord>;

export const UsageEvent = z.object({
  id: RecordId,
  workspaceId: RecordId,
  projectId: RecordId.optional(),
  jobId: RecordId.optional(),
  /** Billable operation name (see `@motion-mcp/billing` CREDIT_PRICES). */
  operation: z.string().min(1).max(64),
  quantity: z.number().min(0),
  credits: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
  byok: z.boolean().default(false),
  createdAt: Timestamp,
});
export type UsageEvent = z.infer<typeof UsageEvent>;
