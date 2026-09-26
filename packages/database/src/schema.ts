import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Production PostgreSQL data model (schema only; the Postgres repositories land in a later phase).
 * Ids are application-generated text ids (`prefix_<time><random>`, see `newId`). Large binaries live in
 * object storage; rows keep only storage keys. Requires the `vector` extension for `search_documents`.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => text("id").primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const EMBEDDING_DIMENSIONS = 1536;

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: createdAt(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    name: text("name").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    plan: text("plan").notNull().default("free"),
    /** Overdraft allowance in credits for postpaid workspaces (0 = prepaid only). */
    overdraftCredits: integer("overdraft_credits").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("workspaces_owner_idx").on(t.ownerId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** sha256 hex of the key; plaintext is never stored. */
    hash: text("hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.hash), index("api_keys_workspace_idx").on(t.workspaceId)],
);

export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    directorMode: text("director_mode").notNull(),
    status: text("status").notNull().default("draft"),
    creativeSpec: jsonb("creative_spec"),
    currentTastePacketId: text("current_taste_packet_id"),
    currentIrVersion: integer("current_ir_version").notNull().default(0),
    /** `{ preview?, final?, contactSheet?, projectDir }` storage keys. */
    artifacts: jsonb("artifacts").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const videos = pgTable(
  "videos",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    fps: integer("fps").notNull(),
    durationSeconds: real("duration_seconds"),
    status: text("status").notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("videos_project_idx").on(t.projectId)],
);

export const scenes = pgTable(
  "scenes",
  {
    id: id(),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    /** Scene id inside the Motion IR (kebab-case). */
    sceneKey: text("scene_key").notNull(),
    position: integer("position").notNull(),
    role: text("role").notNull(),
    durationSeconds: real("duration_seconds").notNull(),
    spec: jsonb("spec").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("scenes_video_key_uq").on(t.videoId, t.sceneKey)],
);

export const motionIrVersions = pgTable(
  "motion_ir_versions",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Motion IR schema version (for example "0.1"). */
    schemaVersion: text("schema_version").notNull(),
    ir: jsonb("ir").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("motion_ir_versions_project_version_uq").on(t.projectId, t.version)],
);

export const versions = pgTable(
  "versions",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    parentVersionId: text("parent_version_id"),
    motionIrVersionId: text("motion_ir_version_id").references(() => motionIrVersions.id),
    note: text("note"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("versions_project_number_uq").on(t.projectId, t.number)],
);

export const tastePackets = pgTable(
  "taste_packets",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** Director that produced it: host-opus, internal-opus or custom. */
    source: text("source").notNull(),
    packet: jsonb("packet").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("taste_packets_project_idx").on(t.projectId)],
);

export const tastePreferences = pgTable(
  "taste_preferences",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    weight: real("weight").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("taste_preferences_scope_key_uq").on(t.workspaceId, t.userId, t.key)],
);

export const recipes = pgTable(
  "recipes",
  {
    id: id(),
    /** Null for platform-wide recipes. */
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    recipe: jsonb("recipe").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("recipes_workspace_idx").on(t.workspaceId)],
);

export const assets = pgTable(
  "assets",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    /** provided | generate | registry */
    source: text("source").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("assets_project_idx").on(t.projectId), uniqueIndex("assets_storage_key_uq").on(t.storageKey)],
);

export const renders = pgTable(
  "renders",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: text("version_id").references(() => versions.id),
    jobId: text("job_id"),
    quality: text("quality").notNull(),
    status: text("status").notNull(),
    storageKey: text("storage_key"),
    width: integer("width"),
    height: integer("height"),
    fps: integer("fps"),
    durationSeconds: real("duration_seconds"),
    bytes: bigint("bytes", { mode: "number" }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("renders_project_idx").on(t.projectId, t.createdAt)],
);

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    /** `{ stage, pct, message }` */
    progress: jsonb("progress").notNull(),
    error: jsonb("error"),
    result: jsonb("result"),
    traceId: text("trace_id"),
    reservationId: text("reservation_id"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("generation_jobs_project_idx").on(t.projectId, t.createdAt),
    index("generation_jobs_status_idx").on(t.status),
  ],
);

export const traces = pgTable(
  "traces",
  {
    /** OpenTelemetry-style trace id. */
    id: id(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    jobId: text("job_id"),
    name: text("name").notNull(),
    root: jsonb("root").notNull(),
    summary: jsonb("summary").notNull(),
    cogsUsd: numeric("cogs_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    createdAt: createdAt(),
  },
  (t) => [index("traces_job_idx").on(t.jobId), index("traces_project_idx").on(t.projectId)],
);

export const modelCalls = pgTable(
  "model_calls",
  {
    id: id(),
    traceId: text("trace_id").references(() => traces.id, { onDelete: "cascade" }),
    spanId: text("span_id"),
    jobId: text("job_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("model_calls_trace_idx").on(t.traceId),
    index("model_calls_model_idx").on(t.model, t.createdAt),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    jobId: text("job_id"),
    operation: text("operation").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    credits: integer("credits").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    byok: boolean("byok").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("usage_events_workspace_time_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * Double-entry credit ledger, one row per transaction; `entries` is `[{ account, amount }]` summing to zero.
 * Mirrors `LedgerTransaction` in `@motion-mcp/billing`.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    entries: jsonb("entries").notNull(),
    /** Net change to the workspace's available balance, denormalized for fast balance queries. */
    availableDelta: integer("available_delta").notNull(),
    heldDelta: integer("held_delta").notNull(),
    idempotencyKey: text("idempotency_key"),
    reservationId: text("reservation_id"),
    operation: text("operation"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_ledger_idempotency_uq").on(t.idempotencyKey),
    index("credit_ledger_workspace_idx").on(t.workspaceId, t.createdAt),
    index("credit_ledger_reservation_idx").on(t.reservationId),
  ],
);

/** Workspace-supplied provider keys (BYOK), encrypted with an envelope key identified by `keyId`. */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    keyId: text("key_id").notNull(),
    /** Last 4 characters for display only. */
    hint: text("hint"),
    createdAt: createdAt(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("provider_credentials_workspace_provider_uq").on(t.workspaceId, t.provider)],
);

export const searchDocuments = pgTable(
  "search_documents",
  {
    id: id(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    /** project | scene | recipe | asset | style */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", ''))`,
    ),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("search_documents_source_uq").on(t.sourceType, t.sourceId),
    index("search_documents_tsv_idx").using("gin", t.tsv),
    index("search_documents_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
