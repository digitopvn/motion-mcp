/**
 * Response shapes of the dashboard `/api` routes. Project, render, search and publish shapes mirror the MCP
 * contract in `packages/pipeline/src/contract/tool-schemas.ts`; the rest follow the API contract in
 * `plans/260927-0943-dashboard/plan.md` ("Contract details"). Fields the server may omit are optional so
 * the UI degrades instead of crashing.
 */

export type DirectorMode = "host-opus" | "internal-opus" | "custom";
export type JobState = "queued" | "running" | "awaiting_host" | "succeeded" | "failed" | "cancelled";
export type Quality = "preview" | "final";
export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:5";

export interface Credits {
  balance: number;
  held: number;
}

export interface User {
  id: string;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface Me {
  user: User;
  workspace: Workspace;
  credits: Credits;
}

export interface Providers {
  github: boolean;
  email: boolean;
}

export interface ProjectListItem {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  createdAt?: string;
  directorMode?: DirectorMode;
  thumbnailUrl?: string;
}

export interface ProjectList {
  projects: ProjectListItem[];
  nextCursor?: string;
}

export interface Overview {
  credits?: Credits;
  projectCount?: number;
  /** Requested additive field (plan.md); absent until the backend provides it. */
  trialCredits?: number;
  recentProjects?: ProjectListItem[];
  usage?: { credits?: number; events?: number; since?: string; until?: string };
}

export interface RenderSummary {
  id: string;
  quality: Quality;
  status: JobState;
  url?: string;
  durationS?: number;
  createdAt: string;
  publishedUrl?: string;
}

export interface JobSummary {
  id: string;
  kind: string;
  state: JobState;
  stage?: string;
  progress: number;
  message?: string;
  error?: { code: string; message: string };
}

export interface QaIssue {
  id: string;
  sceneId?: string;
  category: string;
  severity: "info" | "warn" | "error";
  message: string;
  source: string;
}

export interface IrScene {
  id: string;
  role?: string;
  intent?: string;
  duration?: number;
  focalPoint?: string;
}

export interface ProjectDetail {
  project: {
    id: string;
    title: string;
    status: string;
    currentVersion: number;
    directorMode: DirectorMode;
    createdAt: string;
    updatedAt: string;
  };
  job?: JobSummary;
  contactSheetUrl?: string;
  renders?: RenderSummary[];
  versions?: { version: number; createdAt: string; source: string }[];
  usage?: { credits: number; costUsd: number; breakdown: Record<string, unknown>[] };
  qaIssues?: QaIssue[];
  trace?: string;
  ir?: Record<string, unknown>;
}

export interface CreateProjectInput {
  brief: string;
  directorMode: DirectorMode;
  durationSeconds?: number;
  format?: { aspectRatio: AspectRatio };
  quality: Quality;
}

export interface CreateProjectOutput {
  projectId: string;
  jobId: string;
  status: JobState;
  directorMode: DirectorMode;
  next: string;
}

export interface RenderOutput {
  projectId: string;
  renderId: string;
  jobId: string;
  status: JobState;
  estimatedCredits: number;
  next: string;
}

export interface PublishOutput {
  url: string;
  renderId: string;
  visibility: "unlisted" | "public";
}

/** Subset of `TraceSummary` from packages/observability/src/tracer.ts. */
export interface TraceSummary {
  durationMs?: number;
  cogsUsd?: number;
  modelCalls?: number;
  failures?: number;
  retries?: number;
}

export interface TraceListItem {
  id: string;
  name?: string;
  projectId?: string;
  jobId?: string;
  createdAt?: string;
  summary?: TraceSummary;
}

export interface ModelUsage {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Span {
  spanId: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: "unset" | "ok" | "error";
  error?: string;
  modelCalls?: ModelUsage[];
  costs?: Record<string, number>;
  retries?: number;
  children?: Span[];
}

export interface TraceDetail {
  trace: TraceListItem & { root?: Span };
}

export type SearchDocType = "project" | "scene" | "style" | "pattern" | "recipe";

export interface SearchResult {
  type: SearchDocType;
  id: string;
  title: string;
  snippet: string;
  score: number;
}

export interface SearchOutput {
  results: SearchResult[];
  exact: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  revokedAt?: string | null;
}

export interface CreatedApiKey {
  key: ApiKey;
  /** Plaintext `mmcp_...` key, returned only once. */
  secret: string;
}

export interface UsageEvent {
  id?: string;
  projectId?: string;
  jobId?: string;
  operation: string;
  quantity?: number;
  credits: number;
  byok?: boolean;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  kind: string;
  operation?: string;
  availableDelta: number;
  heldDelta: number;
  createdAt: string;
}

export interface Usage {
  since?: string;
  until?: string;
  totals?: { credits: number; events: number };
  events: UsageEvent[];
  ledger: LedgerEntry[];
}

export interface Price {
  operation: string;
  credits: number;
  unit: string;
}

export interface Billing {
  credits: Credits;
  creditUsd?: number;
  /** Array of prices; the raw `CREDIT_PRICES` record keyed by operation is also accepted (`normalizePrices`). */
  prices: Price[] | Record<string, { credits: number; unit: string }>;
  checkout?: { enabled: boolean };
}

export type CheckoutResult = { enabled: true; url: string } | { enabled: false };

export interface RecipeFormat {
  width?: number;
  height?: number;
  fps?: number;
  aspectRatio?: AspectRatio;
}

export interface Recipe {
  id: string;
  name: string;
  brief: string;
  directorMode?: DirectorMode | null;
  format?: RecipeFormat | null;
  durationSeconds?: number | null;
  quality?: Quality | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** POST/PATCH body; `null` clears an optional field on PATCH. */
export interface RecipeInput {
  name: string;
  brief: string;
  directorMode: DirectorMode;
  format: RecipeFormat;
  durationSeconds: number;
  quality: Quality;
  notes?: string | null;
}

export type ProviderAuthType = "oauth" | "api_key";

export interface PiProvider {
  id: string;
  name: string;
  apiKey: { name: string } | null;
  oauth: { name: string; loginLabel: string | null } | null;
  connected: { authType: ProviderAuthType; hint: string | null; updatedAt: string } | null;
}

export interface PiModelChoice {
  provider: string;
  model: string;
}

export interface MultixKey {
  name: string;
  providers: string[];
  set: boolean;
  hint: string | null;
  updatedAt: string | null;
}

export interface ProvidersOverview {
  enabled: boolean;
  pi: {
    providers: PiProvider[];
    selected: PiModelChoice | null;
    models: Record<string, { id: string; name: string }[]>;
  };
  multix: { keys: MultixKey[] };
}

export type PiLoginEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string };

export interface PiLoginPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface PiLogin {
  id: string;
  provider: string;
  type: ProviderAuthType;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  events: PiLoginEvent[];
  prompt: PiLoginPrompt | null;
  error: string | null;
}
