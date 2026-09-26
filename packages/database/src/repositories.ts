import type { ApiKey, Job, JobStatus, Project, TraceRecord, UsageEvent } from "./entities.ts";

/** Fields fixed at creation time; every other field may be patched. */
type Immutable = "id" | "createdAt" | "updatedAt";

export type NewProject = Omit<Project, Immutable | "id" | "irVersion" | "status"> &
  Partial<Pick<Project, "id" | "irVersion" | "status">>;
export type ProjectPatch = Partial<Omit<Project, Immutable | "workspaceId">>;

export type NewJob = Omit<Job, Immutable | "id" | "status" | "progress"> &
  Partial<Pick<Job, "id" | "status" | "progress">>;
export type JobPatch = Partial<Omit<Job, Immutable | "projectId" | "kind">>;

/** A patch, or a function computing one from the current record (applied atomically under a lock). */
export type Patch<T, P> = P | ((current: T) => P);

export interface ProjectRepo {
  create(input: NewProject): Promise<Project>;
  get(id: string): Promise<Project | undefined>;
  /** Throws NOT_FOUND when the project does not exist. */
  update(id: string, patch: Patch<Project, ProjectPatch>): Promise<Project>;
  /** Newest first. */
  list(filter: { workspaceId: string; limit?: number }): Promise<Project[]>;
  delete(id: string): Promise<boolean>;
}

export interface JobRepo {
  create(input: NewJob): Promise<Job>;
  get(id: string): Promise<Job | undefined>;
  update(id: string, patch: Patch<Job, JobPatch>): Promise<Job>;
  /** Newest first. */
  list(filter?: { projectId?: string; status?: JobStatus; limit?: number }): Promise<Job[]>;
}

export interface ApiKeyRepo {
  create(record: ApiKey): Promise<ApiKey>;
  get(id: string): Promise<ApiKey | undefined>;
  /** Active (non-revoked) key with this sha256 hash. */
  findActiveByHash(hash: string): Promise<ApiKey | undefined>;
  listByWorkspace(workspaceId: string): Promise<ApiKey[]>;
  revoke(id: string): Promise<ApiKey>;
}

export interface TraceRepo {
  save(record: TraceRecord): Promise<TraceRecord>;
  get(id: string): Promise<TraceRecord | undefined>;
  list(filter: { projectId?: string; jobId?: string; limit?: number }): Promise<TraceRecord[]>;
}

export interface UsageRepo {
  record(
    event: Omit<UsageEvent, "id" | "createdAt"> & Partial<Pick<UsageEvent, "id" | "createdAt">>,
  ): Promise<UsageEvent>;
  /** Oldest first, within [since, until). */
  list(filter: { workspaceId: string; since?: string; until?: string }): Promise<UsageEvent[]>;
}

export interface Repositories {
  projects: ProjectRepo;
  jobs: JobRepo;
  apiKeys: ApiKeyRepo;
  traces: TraceRepo;
  usage: UsageRepo;
}
