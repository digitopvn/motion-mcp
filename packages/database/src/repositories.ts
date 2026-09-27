import type {
  ApiKey,
  Job,
  JobStatus,
  LoginToken,
  Project,
  Recipe,
  Session,
  TraceRecord,
  UsageEvent,
  User,
  Workspace,
} from "./entities.ts";

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

export type NewUser = Omit<User, Immutable> & Partial<Pick<User, "id">>;
export type UserPatch = Partial<Omit<User, Immutable>>;

export interface UserRepo {
  create(input: NewUser): Promise<User>;
  get(id: string): Promise<User | undefined>;
  update(id: string, patch: Patch<User, UserPatch>): Promise<User>;
  findByGithubId(githubId: string): Promise<User | undefined>;
  /** Case-insensitive match on the stored email. */
  findByEmail(email: string): Promise<User | undefined>;
}

export type NewWorkspace = Omit<Workspace, "id" | "createdAt"> & Partial<Pick<Workspace, "id">>;

export interface WorkspaceRepo {
  create(input: NewWorkspace): Promise<Workspace>;
  get(id: string): Promise<Workspace | undefined>;
  /** Oldest first, so the first entry is the user's personal workspace. */
  listByOwner(userId: string): Promise<Workspace[]>;
}

export interface SessionRepo {
  /** The session id is derived from the token hash, so lookups by hash are a single read. */
  create(input: Pick<Session, "userId" | "tokenHash" | "expiresAt">): Promise<Session>;
  /** The session with this token hash, or undefined when unknown or expired (expired ones are deleted). */
  findByTokenHash(tokenHash: string, now?: Date): Promise<Session | undefined>;
  /** Slide the expiry window forward and record activity. */
  touch(id: string, patch: Pick<Session, "lastSeenAt" | "expiresAt">): Promise<Session>;
  delete(id: string): Promise<boolean>;
}

export interface LoginTokenRepo {
  create(input: Pick<LoginToken, "email" | "tokenHash" | "expiresAt" | "next">): Promise<LoginToken>;
  /**
   * Atomically mark the token used. Returns it only on the first successful use before expiry;
   * unknown, expired or already used tokens return undefined.
   */
  consume(tokenHash: string, now?: Date): Promise<LoginToken | undefined>;
}

export type NewRecipe = Omit<Recipe, Immutable> & Partial<Pick<Recipe, "id">>;
export type RecipePatch = Partial<Omit<Recipe, Immutable | "workspaceId">>;

export interface RecipeRepo {
  create(input: NewRecipe): Promise<Recipe>;
  get(id: string): Promise<Recipe | undefined>;
  update(id: string, patch: Patch<Recipe, RecipePatch>): Promise<Recipe>;
  /** Newest first. */
  list(filter: { workspaceId: string; limit?: number }): Promise<Recipe[]>;
  delete(id: string): Promise<boolean>;
}

export interface Repositories {
  projects: ProjectRepo;
  jobs: JobRepo;
  apiKeys: ApiKeyRepo;
  traces: TraceRepo;
  usage: UsageRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  sessions: SessionRepo;
  loginTokens: LoginTokenRepo;
  recipes: RecipeRepo;
}
