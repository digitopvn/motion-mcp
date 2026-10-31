import { ClaudeSceneWorker, probeSandbox, type SandboxProbe } from "@motion-mcp/claude-agent-runtime";
import {
  type ClaudeFallback,
  ClaudeSettings,
  type ModelBackend,
  type Repositories,
  type WorkerBackend,
} from "@motion-mcp/database";
import { AnthropicClient, type Completion, type CompletionRequest, type ModelGateway } from "@motion-mcp/llm";
import type { SceneWorker } from "@motion-mcp/pi-runtime";
import {
  AUTH_REJECTED,
  type Logger,
  type MotionConfig,
  MotionError,
  registerSecret,
  type SealedBox,
  toMotionError,
} from "@motion-mcp/shared";

/** Connection state shown in the dashboard. `connecting` and `expired` are reserved for subscription OAuth. */
export type ClaudeStatus =
  | "unconfigured"
  | "connecting"
  | "connected"
  | "expired"
  | "revoked"
  | "unavailable"
  | "blocked_by_policy";

const nowIso = () => new Date().toISOString();
const KIND = "claude";
const PROVIDER = "anthropic";
const aad = (workspaceId: string) => `${workspaceId}:${KIND}:${PROVIDER}`;
/** Anthropic API keys look like `sk-ant-api03-…`; admin keys (`sk-ant-admin…`) are refused. */
const API_KEY = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,250}$/;

/**
 * Backends a job runs with, fixed when it is enqueued so a settings change mid-queue cannot switch who
 * pays. Only the choice is stored; the key is read from the encrypted store when the job runs.
 */
export interface ClaudeJobSelection {
  director: ModelBackend;
  critic: ModelBackend;
  sceneWorker: WorkerBackend;
  directorModel: string;
  criticModel: string;
  workerModel: string;
  fallback: ClaudeFallback;
}

/** A model role served by the workspace's own Anthropic key. */
export interface RoleBackend {
  gateway: ModelGateway;
  model: string;
  /** The workspace pays the provider directly; billing waives the matching model-call credits. */
  byok: true;
}

export type ClaudeRole = "director" | "critic";

/** What a job resolved from its selection. Absent role = server default. */
export interface ResolvedClaudeBackends {
  director?: RoleBackend;
  critic?: RoleBackend;
  /** Set when the role was pinned to the workspace key, the key is unusable and fallback is `none`. */
  unavailable: Partial<Record<ClaudeRole, MotionError>>;
  /** `undefined` keeps the default worker resolution; `null` means no worker (deterministic compile). */
  worker?: SceneWorker | null;
  warnings: string[];
}

export interface ClaudeOverview {
  enabled: boolean;
  status: ClaudeStatus;
  apiKey: { hint?: string; updatedAt: string } | null;
  keyState?: ClaudeSettings["keyState"];
  settings: ClaudeJobSelection;
  models: string[];
  worker: { available: boolean; sandbox: string; reason?: string };
  subscription: { status: "blocked_by_policy"; reason: string };
}

export const SUBSCRIPTION_POLICY_REASON =
  "Claude subscription sign-in is unavailable for this hosted service: Anthropic does not permit " +
  "consumer subscription credentials to power third-party hosted products. Use an Anthropic API key.";

export interface WorkspaceClaudeOptions {
  repos: Repositories;
  box?: SealedBox;
  logger: Logger;
  config: Pick<
    MotionConfig,
    | "CLAUDE_DIRECTOR_MODEL"
    | "CLAUDE_CRITIC_MODEL"
    | "CLAUDE_WORKER_MODEL"
    | "CLAUDE_MODELS"
    | "CLAUDE_WORKER_SANDBOX"
    | "CLAUDE_WORKER_MAX_TURNS"
    | "CLAUDE_WORKER_TIMEOUT_MS"
  >;
  /** `false` when the server runs deterministic-only implementation. */
  workersAllowed: boolean;
  /** Test seams. */
  createGateway?: (apiKey: string) => ModelGateway & { verifyKey(signal?: AbortSignal): Promise<void> };
  createWorker?: (options: { apiKey: string; model: string }) => SceneWorker;
  probe?: () => SandboxProbe;
}

/**
 * A workspace's Anthropic API key (BYOK) and its per-role Claude selection. The key is sealed at rest,
 * never returned, and only ever handed to an explicit client: no role reads `ANTHROPIC_API_KEY` or
 * `~/.claude` from the server environment.
 */
export class WorkspaceClaude {
  constructor(private readonly opts: WorkspaceClaudeOptions) {}

  get enabled(): boolean {
    return this.opts.box !== undefined;
  }

  get models(): string[] {
    const list = this.opts.config.CLAUDE_MODELS.split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const defaults = [
      this.opts.config.CLAUDE_DIRECTOR_MODEL,
      this.opts.config.CLAUDE_CRITIC_MODEL,
      this.opts.config.CLAUDE_WORKER_MODEL,
    ];
    return [...new Set([...list, ...defaults])];
  }

  workerProbe(): SandboxProbe & { available: boolean } {
    if (!this.opts.workersAllowed) {
      return {
        ok: false,
        mode: this.opts.config.CLAUDE_WORKER_SANDBOX,
        available: false,
        reason: "Scene workers are off on this server (IMPLEMENTATION_MODE=deterministic)",
      };
    }
    const probe = this.opts.probe?.() ?? probeSandbox(this.opts.config.CLAUDE_WORKER_SANDBOX);
    return { ...probe, available: probe.ok };
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

  private selection(settings: ClaudeSettings | undefined): ClaudeJobSelection {
    const s = ClaudeSettings.parse(settings ?? {});
    const c = this.opts.config;
    return {
      director: s.director,
      critic: s.critic,
      sceneWorker: s.sceneWorker,
      directorModel: s.directorModel ?? c.CLAUDE_DIRECTOR_MODEL,
      criticModel: s.criticModel ?? c.CLAUDE_CRITIC_MODEL,
      workerModel: s.workerModel ?? c.CLAUDE_WORKER_MODEL,
      fallback: s.fallback,
    };
  }

  async overview(workspaceId: string): Promise<ClaudeOverview> {
    const workspace = await this.opts.repos.workspaces.get(workspaceId);
    const record = this.enabled
      ? await this.opts.repos.providerCredentials.get(workspaceId, KIND, PROVIDER)
      : undefined;
    const keyState = workspace?.claude?.keyState;
    let status: ClaudeStatus;
    if (!this.enabled) status = "unavailable";
    else if (!record) status = "unconfigured";
    else if (keyState?.status === "rejected") status = "revoked";
    else status = "connected";
    const probe = this.workerProbe();
    return {
      enabled: this.enabled,
      status,
      apiKey: record ? { hint: record.hint, updatedAt: record.updatedAt } : null,
      keyState: record ? keyState : undefined,
      settings: this.selection(workspace?.claude),
      models: this.models,
      worker: {
        available: probe.available,
        sandbox: probe.mode,
        ...(probe.reason ? { reason: probe.reason } : {}),
      },
      subscription: { status: "blocked_by_policy", reason: SUBSCRIPTION_POLICY_REASON },
    };
  }

  private gatewayFor(apiKey: string) {
    return this.opts.createGateway?.(apiKey) ?? new AnthropicClient({ apiKey });
  }

  /** Verify (free `GET /v1/models`) and store the workspace key. A rejected key is not stored. */
  async setKey(workspaceId: string, apiKey: string): Promise<void> {
    const box = this.requireBox();
    const key = apiKey.trim();
    if (!API_KEY.test(key)) {
      throw new MotionError("VALIDATION", "That does not look like an Anthropic API key (sk-ant-api…)");
    }
    await this.verify(key);
    registerSecret(key);
    await this.opts.repos.providerCredentials.put({
      workspaceId,
      kind: KIND,
      provider: PROVIDER,
      authType: "api_key",
      ...box.seal(key, aad(workspaceId)),
      hint: key.slice(-4),
    });
    await this.setKeyState(workspaceId, { status: "valid", checkedAt: nowIso() });
  }

  async deleteKey(workspaceId: string): Promise<boolean> {
    this.requireBox();
    const deleted = await this.opts.repos.providerCredentials.delete(workspaceId, KIND, PROVIDER);
    await this.setKeyState(workspaceId, undefined);
    return deleted;
  }

  /** Re-check the stored key and record the result. */
  async testKey(workspaceId: string): Promise<NonNullable<ClaudeSettings["keyState"]>> {
    const key = await this.readKey(workspaceId);
    if (!key) throw new MotionError("NOT_FOUND", "No Anthropic API key is stored for this workspace");
    try {
      await this.verify(key);
    } catch (err) {
      const error = toMotionError(err);
      if (error.details?.reason !== AUTH_REJECTED) throw error;
      const state = {
        status: "rejected" as const,
        checkedAt: nowIso(),
        message: error.message.slice(0, 300),
      };
      await this.setKeyState(workspaceId, state);
      return state;
    }
    const state = { status: "valid" as const, checkedAt: nowIso() };
    await this.setKeyState(workspaceId, state);
    return state;
  }

  private async verify(key: string): Promise<void> {
    try {
      await this.gatewayFor(key).verifyKey(AbortSignal.timeout(15_000));
    } catch (err) {
      const error = toMotionError(err, "PROVIDER");
      if (error.details?.reason === AUTH_REJECTED) {
        throw new MotionError("VALIDATION", "Anthropic rejected this API key", {
          details: { reason: AUTH_REJECTED },
        });
      }
      throw error;
    }
  }

  /** Update role selection. Roles can only move to Claude when the workspace holds a usable key. */
  async updateSettings(
    workspaceId: string,
    patch: Partial<Omit<ClaudeSettings, "keyState">>,
  ): Promise<ClaudeJobSelection> {
    this.requireBox();
    const workspace = await this.opts.repos.workspaces.get(workspaceId);
    if (!workspace) throw new MotionError("NOT_FOUND", "Workspace not found");
    const next = ClaudeSettings.parse({ ...workspace.claude, ...patch });
    for (const field of ["directorModel", "criticModel", "workerModel"] as const) {
      const model = next[field];
      if (model && !this.models.includes(model)) {
        throw new MotionError("VALIDATION", `${field} must be one of: ${this.models.join(", ")}`);
      }
    }
    const usesClaude =
      next.director === "anthropic-api" ||
      next.critic === "anthropic-api" ||
      next.sceneWorker === "claude-agent-sdk";
    const turnsOn =
      (patch.director === "anthropic-api" && workspace.claude?.director !== "anthropic-api") ||
      (patch.critic === "anthropic-api" && workspace.claude?.critic !== "anthropic-api") ||
      (patch.sceneWorker === "claude-agent-sdk" && workspace.claude?.sceneWorker !== "claude-agent-sdk");
    if (usesClaude && turnsOn) {
      const record = await this.opts.repos.providerCredentials.get(workspaceId, KIND, PROVIDER);
      if (!record) throw new MotionError("VALIDATION", "Store an Anthropic API key before choosing Claude");
    }
    if (patch.sceneWorker === "claude-agent-sdk" && workspace.claude?.sceneWorker !== "claude-agent-sdk") {
      const probe = this.workerProbe();
      if (!probe.available) {
        throw new MotionError(
          "VALIDATION",
          `The Claude scene worker is unavailable on this server: ${probe.reason}`,
        );
      }
    }
    await this.opts.repos.workspaces.update(workspaceId, { claude: next });
    return this.selection(next);
  }

  /** The selection to pin on a new job, or undefined when every role uses the server defaults. */
  async snapshot(workspaceId: string): Promise<ClaudeJobSelection | undefined> {
    if (!this.enabled) return undefined;
    const workspace = await this.opts.repos.workspaces.get(workspaceId);
    const selection = this.selection(workspace?.claude);
    const usesClaude =
      selection.director === "anthropic-api" ||
      selection.critic === "anthropic-api" ||
      selection.sceneWorker === "claude-agent-sdk";
    return usesClaude ? selection : undefined;
  }

  /** True when a create job for this workspace can run the internal director without the server key. */
  async directorAvailable(workspaceId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const workspace = await this.opts.repos.workspaces.get(workspaceId);
    if (this.selection(workspace?.claude).director !== "anthropic-api") return false;
    if (workspace?.claude?.keyState?.status === "rejected") return false;
    return (await this.opts.repos.providerCredentials.get(workspaceId, KIND, PROVIDER)) !== undefined;
  }

  /** Turn a pinned selection into live clients for one job. */
  async resolve(
    workspaceId: string,
    selection: ClaudeJobSelection | undefined,
  ): Promise<ResolvedClaudeBackends> {
    const out: ResolvedClaudeBackends = { unavailable: {}, warnings: [] };
    if (!selection) return out;
    const workspace = await this.opts.repos.workspaces.get(workspaceId);
    let key: string | undefined;
    let version: string | undefined;
    let problem: string | undefined;
    try {
      ({ key, version } = (await this.readStored(workspaceId)) ?? {});
      if (!key) problem = "no Anthropic API key is stored";
      else if (workspace?.claude?.keyState?.status === "rejected") {
        problem = "the stored Anthropic API key was rejected";
        key = undefined;
      }
    } catch (err) {
      problem = `the Anthropic API key cannot be read (${toMotionError(err).message})`;
    }

    const roles: Array<[ClaudeRole, string]> = [
      ["director", selection.directorModel],
      ["critic", selection.criticModel],
    ];
    for (const [role, model] of roles) {
      if (selection[role] !== "anthropic-api") continue;
      if (key) {
        out[role] = {
          gateway: this.watchGateway(workspaceId, version, this.gatewayFor(key)),
          model,
          byok: true,
        };
      } else if (selection.fallback === "server") {
        out.warnings.push(`Claude ${role} unavailable (${problem}); used the server default`);
      } else {
        out.unavailable[role] = new MotionError(
          "CONFIG",
          `This job uses the workspace's Anthropic key for the ${role}, but ${problem}. ` +
            "Update the key on the Providers page, or allow the server fallback.",
          { details: { reason: "claude_key_unavailable", role } },
        );
      }
    }

    if (selection.sceneWorker === "claude-agent-sdk") {
      const probe = this.workerProbe();
      const why = !key ? problem : !probe.available ? `sandbox unavailable: ${probe.reason}` : undefined;
      if (!why && key) {
        const worker =
          this.opts.createWorker?.({ apiKey: key, model: selection.workerModel }) ??
          new ClaudeSceneWorker({
            apiKey: key,
            model: selection.workerModel,
            sandbox: this.opts.config.CLAUDE_WORKER_SANDBOX,
            maxTurns: this.opts.config.CLAUDE_WORKER_MAX_TURNS,
            timeoutMs: this.opts.config.CLAUDE_WORKER_TIMEOUT_MS,
          });
        out.worker = this.watchWorker(workspaceId, version, worker);
      } else if (selection.fallback === "server") {
        out.warnings.push(`Claude scene worker unavailable (${why}); used the server default`);
      } else {
        out.worker = null;
        out.warnings.push(`Claude scene worker unavailable (${why}); scenes used the deterministic compiler`);
      }
    }
    return out;
  }

  private async readKey(workspaceId: string): Promise<string | undefined> {
    return (await this.readStored(workspaceId))?.key;
  }

  /** The stored key plus its `updatedAt`, which identifies this key among later replacements. */
  private async readStored(workspaceId: string): Promise<{ key: string; version: string } | undefined> {
    if (!this.opts.box) return undefined;
    const record = await this.opts.repos.providerCredentials.get(workspaceId, KIND, PROVIDER);
    if (!record) return undefined;
    const key = this.opts.box.open(record, aad(workspaceId));
    registerSecret(key);
    return { key, version: record.updatedAt };
  }

  private async setKeyState(workspaceId: string, state: ClaudeSettings["keyState"]): Promise<void> {
    const workspace = await this.opts.repos.workspaces.get(workspaceId);
    if (!workspace) return;
    const current = ClaudeSettings.parse(workspace.claude ?? {});
    await this.opts.repos.workspaces.update(workspaceId, { claude: { ...current, keyState: state } });
  }

  /**
   * Record a key Anthropic rejected mid-job so the dashboard shows `revoked` and later jobs stop using it.
   * `version` is the key the job resolved; if the workspace has since saved a new key, the rejection is
   * about the old one and the new key's state is left alone.
   */
  private async onAuthRejected(
    workspaceId: string,
    version: string | undefined,
    err: unknown,
  ): Promise<void> {
    const error = toMotionError(err);
    if (error.details?.reason !== AUTH_REJECTED) return;
    this.opts.logger.warn("providers.claude_key_rejected", { workspaceId });
    const current = await this.opts.repos.providerCredentials
      .get(workspaceId, KIND, PROVIDER)
      .catch(() => undefined);
    if (!current || current.updatedAt !== version) return;
    await this.setKeyState(workspaceId, {
      status: "rejected",
      checkedAt: nowIso(),
      message: error.message.slice(0, 300),
    }).catch(() => undefined);
  }

  private watchGateway(
    workspaceId: string,
    version: string | undefined,
    gateway: ModelGateway,
  ): ModelGateway {
    return {
      complete: async (request: CompletionRequest): Promise<Completion> => {
        try {
          return await gateway.complete(request);
        } catch (err) {
          await this.onAuthRejected(workspaceId, version, err);
          throw err;
        }
      },
    };
  }

  private watchWorker(workspaceId: string, version: string | undefined, worker: SceneWorker): SceneWorker {
    const guard = async <T>(task: () => Promise<T>): Promise<T> => {
      try {
        return await task();
      } catch (err) {
        await this.onAuthRejected(workspaceId, version, err);
        throw err;
      }
    };
    return {
      name: worker.name,
      buildScene: (input) => guard(() => worker.buildScene(input)),
      patchScene: (input) => guard(() => worker.patchScene(input)),
    };
  }
}
