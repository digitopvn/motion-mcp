import type { ProviderCredential, Repositories } from "@motion-mcp/database";
import { multixEnvKeys } from "@motion-mcp/media";
import {
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createPiModelRuntime,
  type ModelRuntime,
  PiWorker,
  type SceneWorker,
} from "@motion-mcp/pi-runtime";
import { type Logger, MotionError, registerSecret, type SealedBox } from "@motion-mcp/shared";

const piAad = (workspaceId: string, provider: string) => `${workspaceId}:pi:${provider}`;
const multixAad = (workspaceId: string, name: string) => `${workspaceId}:multix:${name}`;

/** Last 4 characters of a long enough key, for display; nothing for short values. */
export function keyHint(value: string): string | undefined {
  return value.length >= 12 ? value.slice(-4) : undefined;
}

function registerCredential(cred: Credential): void {
  if (cred.type === "api_key") registerSecret(cred.key);
  else {
    registerSecret(cred.access);
    registerSecret(cred.refresh);
  }
}

/**
 * Pi's `CredentialStore` over one workspace's encrypted records. Values are returned verbatim: unlike
 * pi's file store, a stored key is never expanded as `$ENV` or run as a `!command`.
 */
export class WorkspaceCredentialStore implements CredentialStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repos: Repositories,
    private readonly box: SealedBox,
    private readonly workspaceId: string,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const record = await this.repos.providerCredentials.get(this.workspaceId, "pi", providerId);
    return record ? this.open(record) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const records = await this.repos.providerCredentials.list(this.workspaceId, "pi");
    return records.map((r) => ({ providerId: r.provider, type: r.authType }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.serialized(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      registerCredential(next);
      const sealed = this.box.seal(JSON.stringify(next), piAad(this.workspaceId, providerId));
      await this.repos.providerCredentials.put({
        workspaceId: this.workspaceId,
        kind: "pi",
        provider: providerId,
        authType: next.type,
        ...sealed,
        hint: next.type === "api_key" && next.key ? keyHint(next.key) : undefined,
      });
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.serialized(providerId, () =>
      this.repos.providerCredentials.delete(this.workspaceId, "pi", providerId),
    );
  }

  private open(record: ProviderCredential): Credential {
    const cred = JSON.parse(this.box.open(record, piAad(this.workspaceId, record.provider))) as Credential;
    registerCredential(cred);
    return cred;
  }

  private serialized<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(providerId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.locks.set(providerId, tail);
    void tail.then(() => {
      if (this.locks.get(providerId) === tail) this.locks.delete(providerId);
    });
    return run;
  }
}

export interface WorkspaceProvidersOptions {
  repos: Repositories;
  /** Absent without CREDENTIALS_ENCRYPTION_KEY: nothing is stored and every job uses the server default. */
  box?: SealedBox;
  logger: Logger;
  /** Server default scene worker (or none). */
  defaultWorker?: SceneWorker;
  /** `false` when the server runs deterministic-only implementation. */
  workersAllowed: boolean;
}

/** Workspace-owned model providers: pi sign-ins (OAuth or API key) and multix API keys. */
export class WorkspaceProviders {
  private readonly runtimes = new Map<string, Promise<ModelRuntime>>();
  private readonly workers = new Map<string, { key: string; worker: PiWorker }>();

  constructor(private readonly opts: WorkspaceProvidersOptions) {}

  get enabled(): boolean {
    return this.opts.box !== undefined;
  }

  private requireBox(): SealedBox {
    if (!this.opts.box) {
      throw new MotionError(
        "CONFIG",
        "Provider keys are not configured on this server (CREDENTIALS_ENCRYPTION_KEY)",
      );
    }
    return this.opts.box;
  }

  /** The workspace's pi model runtime; its credential store is the workspace's encrypted records. */
  piRuntime(workspaceId: string): Promise<ModelRuntime> {
    const box = this.requireBox();
    let runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      runtime = createPiModelRuntime(new WorkspaceCredentialStore(this.opts.repos, box, workspaceId));
      runtime.catch(() => this.runtimes.delete(workspaceId));
      this.runtimes.set(workspaceId, runtime);
    }
    return runtime;
  }

  /**
   * The scene worker for a workspace's jobs: its chosen pi model when the workspace holds a stored
   * credential for that provider, else the server default. A choice without a stored credential never
   * runs, so pi's ambient environment fallback cannot spend the server's own keys for a workspace.
   */
  async sceneWorkerFor(workspaceId: string): Promise<SceneWorker | undefined> {
    const fallback = this.opts.defaultWorker;
    if (!this.enabled || !this.opts.workersAllowed) return fallback;
    const workspace = await this.opts.repos.workspaces.get(workspaceId);
    const choice = workspace?.piModel;
    if (!choice) return fallback;
    const stored = await this.opts.repos.providerCredentials.get(workspaceId, "pi", choice.provider);
    if (!stored) {
      this.opts.logger.warn("providers.model_without_credential", { workspaceId, provider: choice.provider });
      return fallback;
    }
    const runtime = await this.piRuntime(workspaceId);
    if (!runtime.getModel(choice.provider, choice.model)) {
      this.opts.logger.warn("providers.model_unknown", {
        workspaceId,
        provider: choice.provider,
        model: choice.model,
      });
      return fallback;
    }
    const key = `${choice.provider}/${choice.model}`;
    const cached = this.workers.get(workspaceId);
    if (cached?.key === key) return cached.worker;
    const worker = new PiWorker({ modelRuntime: runtime, provider: choice.provider, model: choice.model });
    this.workers.set(workspaceId, { key, worker });
    return worker;
  }

  /** Stores or replaces one multix API key for a workspace. */
  async setMultixKey(workspaceId: string, name: string, value: string): Promise<ProviderCredential> {
    const box = this.requireBox();
    if (!multixEnvKeys().some((k) => k.name === name)) {
      throw new MotionError("VALIDATION", `Unknown multix key ${name}`);
    }
    registerSecret(value);
    return this.opts.repos.providerCredentials.put({
      workspaceId,
      kind: "multix",
      provider: name,
      authType: "api_key",
      ...box.seal(value, multixAad(workspaceId, name)),
      hint: keyHint(value),
    });
  }

  /** Environment for a multix run with this workspace's keys (empty when none are stored). */
  async multixEnv(workspaceId: string): Promise<Record<string, string>> {
    if (!this.opts.box) return {};
    const box = this.opts.box;
    const env: Record<string, string> = {};
    for (const record of await this.opts.repos.providerCredentials.list(workspaceId, "multix")) {
      const value = box.open(record, multixAad(workspaceId, record.provider));
      registerSecret(value);
      env[record.provider] = value;
    }
    return env;
  }
}
