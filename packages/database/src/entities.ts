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

/** A dashboard account. Login identities (GitHub id, verified email) resolve to exactly one user. */
export const User = z.object({
  id: RecordId,
  email: z.email().max(320).optional(),
  name: z.string().min(1).max(200),
  avatarUrl: z.url().max(2000).optional(),
  githubId: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type User = z.infer<typeof User>;

/** Provider and model the workspace's own pi sign-in uses for scene building. */
export const PiModelChoice = z.object({
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(200),
});
export type PiModelChoice = z.infer<typeof PiModelChoice>;

/** One personal workspace per user; the owner is its only member. */
export const Workspace = z.object({
  id: RecordId,
  name: z.string().min(1).max(200),
  ownerUserId: RecordId,
  /** Unset: jobs use the server's default scene worker. */
  piModel: PiModelChoice.optional(),
  createdAt: Timestamp,
});
export type Workspace = z.infer<typeof Workspace>;

const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** Browser session. Only the sha256 of the cookie token is stored. */
export const Session = z.object({
  id: RecordId,
  userId: RecordId,
  tokenHash: Sha256Hex,
  expiresAt: Timestamp,
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
});
export type Session = z.infer<typeof Session>;

/** Single-use email sign-in link. Only the sha256 of the emailed token is stored. */
export const LoginToken = z.object({
  id: RecordId,
  email: z.email().max(320),
  tokenHash: Sha256Hex,
  expiresAt: Timestamp,
  usedAt: Timestamp.optional(),
  /** Same-origin relative path to land on after sign-in. */
  next: z.string().max(500).optional(),
  createdAt: Timestamp,
});
export type LoginToken = z.infer<typeof LoginToken>;

export const RecipeFormat = z.object({
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(320).max(3840).optional(),
  fps: z.number().int().min(12).max(60).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
});
export type RecipeFormat = z.infer<typeof RecipeFormat>;

/** A saved brief/prompt preset in a workspace. */
export const Recipe = z.object({
  id: RecordId,
  workspaceId: RecordId,
  name: z.string().min(1).max(120),
  brief: z.string().min(3).max(8000),
  directorMode: DirectorMode.optional(),
  format: RecipeFormat.optional(),
  durationSeconds: z.number().min(3).max(180).optional(),
  quality: z.enum(["preview", "final"]).optional(),
  notes: z.string().max(4000).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Recipe = z.infer<typeof Recipe>;

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

/** Which tool a stored provider sign-in belongs to. */
export const ProviderKind = z.enum(["pi", "multix"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * A workspace's own provider sign-in (pi OAuth token or API key, or a multix API key), sealed with
 * AES-256-GCM. `provider` is the pi provider id, or the multix environment variable name.
 */
export const ProviderCredential = z.object({
  id: RecordId,
  workspaceId: RecordId,
  kind: ProviderKind,
  provider: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  authType: z.enum(["api_key", "oauth"]),
  ciphertext: z.string().min(1).max(64_000),
  nonce: z.string().min(1).max(64),
  keyId: z.string().regex(/^[a-f0-9]{16}$/),
  /** Last 4 characters of an API key, for display only. */
  hint: z.string().max(8).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProviderCredential = z.infer<typeof ProviderCredential>;
