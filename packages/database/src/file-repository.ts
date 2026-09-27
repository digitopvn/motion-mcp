import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MotionError, newId } from "@motion-mcp/shared";
import type { z } from "zod";
import {
  ApiKey,
  Job,
  LoginToken,
  Project,
  Recipe,
  RecordId,
  Session,
  TraceRecord,
  UsageEvent,
  User,
  Workspace,
} from "./entities.ts";
import type {
  ApiKeyRepo,
  JobPatch,
  JobRepo,
  LoginTokenRepo,
  NewJob,
  NewProject,
  NewRecipe,
  NewUser,
  NewWorkspace,
  Patch,
  ProjectPatch,
  ProjectRepo,
  RecipePatch,
  RecipeRepo,
  Repositories,
  SessionRepo,
  TraceRepo,
  UsageRepo,
  UserPatch,
  UserRepo,
  WorkspaceRepo,
} from "./repositories.ts";

/** Serializes async work per key (one queue per file path). In-process only. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => {
      release = r;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const RETRYABLE_FS = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Atomic replace: write a temp file next to the target, then rename over it (retrying Windows sharing errors). */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 8 || !RETRYABLE_FS.has(code)) {
        await rm(temp, { force: true });
        throw err;
      }
      await delay(10 * 2 ** attempt);
    }
  }
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return undefined;
      if (attempt < 8 && RETRYABLE_FS.has(code)) {
        await delay(10 * 2 ** attempt);
        continue;
      }
      if (err instanceof SyntaxError) {
        throw new MotionError("INTERNAL", `Corrupted record file ${path}`, { cause: err });
      }
      throw err;
    }
  }
}

/** One JSON file per record under `<root>/<collection>/<id>.json`, validated on every read and write. */
class JsonCollection<T extends { id: string }> {
  readonly dir: string;

  constructor(
    root: string,
    readonly name: string,
    private readonly schema: z.ZodType<T>,
    private readonly mutex: KeyedMutex,
  ) {
    this.dir = join(root, name);
  }

  private pathFor(id: string): string {
    if (!RecordId.safeParse(id).success) throw new MotionError("VALIDATION", `Invalid ${this.name} id`);
    return join(this.dir, `${id}.json`);
  }

  private parse(value: unknown, id: string): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new MotionError("VALIDATION", `Invalid ${this.name} record ${id}`, {
        details: { issues: result.error.issues.slice(0, 10) },
      });
    }
    return result.data;
  }

  async get(id: string): Promise<T | undefined> {
    const path = this.pathFor(id);
    const raw = await readJsonFile(path);
    return raw === undefined ? undefined : this.parse(raw, id);
  }

  async insert(record: T): Promise<T> {
    const path = this.pathFor(record.id);
    const valid = this.parse(record, record.id);
    return this.mutex.run(path, async () => {
      if ((await readJsonFile(path)) !== undefined) {
        throw new MotionError("VALIDATION", `${this.name} ${record.id} already exists`);
      }
      await mkdir(this.dir, { recursive: true });
      await atomicWriteJson(path, valid);
      return valid;
    });
  }

  /** Upsert without a read-modify-write (for immutable records such as traces). */
  async put(record: T): Promise<T> {
    const path = this.pathFor(record.id);
    const valid = this.parse(record, record.id);
    return this.mutex.run(path, async () => {
      await mkdir(this.dir, { recursive: true });
      await atomicWriteJson(path, valid);
      return valid;
    });
  }

  /** Read-modify-write under the per-file lock, so concurrent updates never lose writes. */
  async update(id: string, mutate: (current: T) => T): Promise<T> {
    const path = this.pathFor(id);
    return this.mutex.run(path, async () => {
      const raw = await readJsonFile(path);
      if (raw === undefined) throw new MotionError("NOT_FOUND", `${this.name} ${id} not found`);
      const next = this.parse(mutate(this.parse(raw, id)), id);
      if (next.id !== id) throw new MotionError("VALIDATION", `${this.name} id is immutable`);
      await atomicWriteJson(path, next);
      return next;
    });
  }

  async delete(id: string): Promise<boolean> {
    const path = this.pathFor(id);
    return this.mutex.run(path, async () => {
      if ((await readJsonFile(path)) === undefined) return false;
      await rm(path, { force: true });
      return true;
    });
  }

  async all(): Promise<T[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: Array<T | undefined> = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => this.get(f.slice(0, -".json".length))),
    );
    const out: T[] = [];
    for (const record of records) if (record !== undefined) out.push(record);
    return out;
  }
}

const nowIso = () => new Date().toISOString();
const newestFirst = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
const oldestFirst = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const take = <T>(items: T[], limit?: number) =>
  limit === undefined ? items : items.slice(0, Math.max(0, limit));

const SHA256_HEX = /^[a-f0-9]{64}$/;
/** Record ids derived from a token hash make hash lookups a single file read instead of a scan. */
const sessionIdFor = (tokenHash: string) => `ses_${tokenHash.slice(0, 48)}`;
const loginTokenIdFor = (tokenHash: string) => `lt_${tokenHash.slice(0, 48)}`;

function applyPatch<T extends { updatedAt: string }, P extends object>(
  current: T,
  patch: Patch<T, P>,
  immutable: readonly string[],
): T {
  const resolved = typeof patch === "function" ? (patch as (c: T) => P)(current) : patch;
  for (const key of immutable) {
    if (key in resolved) throw new MotionError("VALIDATION", `${key} cannot be changed`);
  }
  return { ...current, ...resolved, updatedAt: nowIso() };
}

/**
 * File-backed repositories: real persistence for local and single-node deploys. Each record is its own
 * JSON file under `<DATA_DIR>/db`, replaced atomically (temp + rename) under a per-file mutex. The lock is
 * per process, so run a single writer process per data directory; multi-node deploys use Postgres.
 */
export class FileRepository implements Repositories {
  readonly root: string;
  readonly projects: ProjectRepo;
  readonly jobs: JobRepo;
  readonly apiKeys: ApiKeyRepo;
  readonly traces: TraceRepo;
  readonly usage: UsageRepo;
  readonly users: UserRepo;
  readonly workspaces: WorkspaceRepo;
  readonly sessions: SessionRepo;
  readonly loginTokens: LoginTokenRepo;
  readonly recipes: RecipeRepo;

  constructor(options: { root: string }) {
    this.root = resolve(options.root);
    const mutex = new KeyedMutex();
    const projects = new JsonCollection(this.root, "projects", Project, mutex);
    const jobs = new JsonCollection(this.root, "jobs", Job, mutex);
    const apiKeys = new JsonCollection(this.root, "api-keys", ApiKey, mutex);
    const traces = new JsonCollection(this.root, "traces", TraceRecord, mutex);
    const usage = new JsonCollection(this.root, "usage", UsageEvent, mutex);

    this.projects = {
      create: (input: NewProject) => {
        const ts = nowIso();
        return projects.insert({
          irVersion: 0,
          status: "draft",
          ...input,
          id: input.id ?? newId("prj"),
          createdAt: ts,
          updatedAt: ts,
        });
      },
      get: (id) => projects.get(id),
      update: (id, patch: Patch<Project, ProjectPatch>) =>
        projects.update(id, (cur) => applyPatch(cur, patch, ["id", "workspaceId", "createdAt"])),
      list: async ({ workspaceId, limit }) =>
        take((await projects.all()).filter((p) => p.workspaceId === workspaceId).sort(newestFirst), limit),
      delete: (id) => projects.delete(id),
    };

    this.jobs = {
      create: (input: NewJob) => {
        const ts = nowIso();
        return jobs.insert({
          status: "queued",
          progress: { stage: "queued", pct: 0, message: "" },
          ...input,
          id: input.id ?? newId("job"),
          createdAt: ts,
          updatedAt: ts,
        });
      },
      get: (id) => jobs.get(id),
      update: (id, patch: Patch<Job, JobPatch>) =>
        jobs.update(id, (cur) => applyPatch(cur, patch, ["id", "projectId", "kind", "createdAt"])),
      list: async (filter = {}) =>
        take(
          (await jobs.all())
            .filter((j) => filter.projectId === undefined || j.projectId === filter.projectId)
            .filter((j) => filter.status === undefined || j.status === filter.status)
            .sort(newestFirst),
          filter.limit,
        ),
    };

    this.apiKeys = {
      create: (record) => apiKeys.insert(record),
      get: (id) => apiKeys.get(id),
      findActiveByHash: async (hash) => (await apiKeys.all()).find((k) => k.hash === hash && !k.revokedAt),
      listByWorkspace: async (workspaceId) =>
        (await apiKeys.all()).filter((k) => k.workspaceId === workspaceId).sort(newestFirst),
      revoke: (id) => apiKeys.update(id, (k) => (k.revokedAt ? k : { ...k, revokedAt: nowIso() })),
    };

    this.traces = {
      save: (record) => traces.put(record),
      get: (id) => traces.get(id),
      list: async ({ projectId, jobId, limit }) =>
        take(
          (await traces.all())
            .filter((t) => projectId === undefined || t.projectId === projectId)
            .filter((t) => jobId === undefined || t.jobId === jobId)
            .sort(newestFirst),
          limit,
        ),
    };

    this.usage = {
      record: (event) =>
        usage.insert({ ...event, id: event.id ?? newId("use"), createdAt: event.createdAt ?? nowIso() }),
      list: async ({ workspaceId, since, until }) =>
        (await usage.all())
          .filter((e) => e.workspaceId === workspaceId)
          .filter((e) => since === undefined || e.createdAt >= since)
          .filter((e) => until === undefined || e.createdAt < until)
          .sort(oldestFirst),
    };

    const users = new JsonCollection(this.root, "users", User, mutex);
    const workspaces = new JsonCollection(this.root, "workspaces", Workspace, mutex);
    const sessions = new JsonCollection(this.root, "sessions", Session, mutex);
    const loginTokens = new JsonCollection(this.root, "login-tokens", LoginToken, mutex);
    const recipes = new JsonCollection(this.root, "recipes", Recipe, mutex);

    this.users = {
      create: (input: NewUser) => {
        const ts = nowIso();
        return users.insert({ ...input, id: input.id ?? newId("usr"), createdAt: ts, updatedAt: ts });
      },
      get: (id) => users.get(id),
      update: (id, patch: Patch<User, UserPatch>) =>
        users.update(id, (cur) => applyPatch(cur, patch, ["id", "createdAt"])),
      findByGithubId: async (githubId) => (await users.all()).find((u) => u.githubId === githubId),
      findByEmail: async (email) => {
        const wanted = email.trim().toLowerCase();
        return (await users.all()).sort(oldestFirst).find((u) => u.email?.toLowerCase() === wanted);
      },
    };

    this.workspaces = {
      create: (input: NewWorkspace) =>
        workspaces.insert({ ...input, id: input.id ?? newId("ws"), createdAt: nowIso() }),
      get: (id) => workspaces.get(id),
      listByOwner: async (userId) =>
        (await workspaces.all()).filter((w) => w.ownerUserId === userId).sort(oldestFirst),
    };

    this.sessions = {
      create: (input) => {
        const ts = nowIso();
        return sessions.insert({
          ...input,
          id: sessionIdFor(input.tokenHash),
          createdAt: ts,
          lastSeenAt: ts,
        });
      },
      findByTokenHash: async (tokenHash, now = new Date()) => {
        if (!SHA256_HEX.test(tokenHash)) return undefined;
        const session = await sessions.get(sessionIdFor(tokenHash));
        if (!session || session.tokenHash !== tokenHash) return undefined;
        if (session.expiresAt <= now.toISOString()) {
          await sessions.delete(session.id);
          return undefined;
        }
        return session;
      },
      touch: (id, patch) => sessions.update(id, (cur) => ({ ...cur, ...patch })),
      delete: (id) => sessions.delete(id),
    };

    this.loginTokens = {
      create: (input) =>
        loginTokens.insert({ ...input, id: loginTokenIdFor(input.tokenHash), createdAt: nowIso() }),
      consume: async (tokenHash, now = new Date()) => {
        if (!SHA256_HEX.test(tokenHash)) return undefined;
        const at = now.toISOString();
        let consumed = false;
        try {
          const record = await loginTokens.update(loginTokenIdFor(tokenHash), (t) => {
            if (t.tokenHash !== tokenHash || t.usedAt !== undefined || t.expiresAt <= at) return t;
            consumed = true;
            return { ...t, usedAt: at };
          });
          return consumed ? record : undefined;
        } catch (err) {
          if (err instanceof MotionError && err.code === "NOT_FOUND") return undefined;
          throw err;
        }
      },
    };

    this.recipes = {
      create: (input: NewRecipe) => {
        const ts = nowIso();
        return recipes.insert({ ...input, id: input.id ?? newId("rcp"), createdAt: ts, updatedAt: ts });
      },
      get: (id) => recipes.get(id),
      update: (id, patch: Patch<Recipe, RecipePatch>) =>
        recipes.update(id, (cur) => applyPatch(cur, patch, ["id", "workspaceId", "createdAt"])),
      list: async ({ workspaceId, limit }) =>
        take((await recipes.all()).filter((r) => r.workspaceId === workspaceId).sort(newestFirst), limit),
      delete: (id) => recipes.delete(id),
    };
  }

  static fromDataDir(dataDir: string): FileRepository {
    return new FileRepository({ root: join(dataDir, "db") });
  }
}
