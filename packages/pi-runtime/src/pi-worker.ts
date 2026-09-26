import { existsSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { MotionScene, QaIssue, ScenePatch } from "@motion-mcp/motion-ir";
import { type Span, startTrace } from "@motion-mcp/observability";
import { type MotionConfig, MotionError, redact, registerSecret, toMotionError } from "@motion-mcp/shared";
import { createPathGuard, isInsideDir, resolveToolPath } from "./path-guard.ts";
import {
  type BuiltPrompt,
  buildPatchPrompt,
  buildScenePrompt,
  type SceneContext,
  sceneFilePath,
  WORKER_SYSTEM_PROMPT,
} from "./prompt-builder.ts";
import { createPiTraceMapper, type PiRunCounters } from "./trace-mapper.ts";

/** Common fields for scene tasks. */
interface SceneTaskBase {
  /** Absolute project directory; becomes the Pi session cwd (guarded, not a sandbox). */
  projectDir: string;
  sceneId: string;
  context?: SceneContext;
  /** Composition contract summary (defaults to the built-in HyperFrames sub-composition contract). */
  contract?: string;
  /** Domain-pack snippets, most relevant first. */
  skills?: readonly string[];
  /** Model id override for this task (defaults to the worker's configured coder model). */
  model?: string;
  span?: Span;
  signal?: AbortSignal;
}

export interface SceneBuildInput extends SceneTaskBase {
  sceneIR: MotionScene;
}

export interface ScenePatchInput extends SceneTaskBase {
  /** Deferred patch instructions (changes the deterministic patcher could not apply). */
  patch?: ScenePatch;
  qaIssues?: readonly QaIssue[];
  sceneIR?: MotionScene;
}

export interface SceneWorkResult {
  sceneId: string;
  /** Project-relative POSIX paths of the files the worker submitted. */
  files: string[];
  notes: string;
  runtime: string;
  model: string;
  durationMs: number;
  counters: PiRunCounters;
}

/** Pluggable scene implementation runtime; the pipeline depends on this, not on Pi. */
export interface SceneWorker {
  readonly name: string;
  buildScene(input: SceneBuildInput): Promise<SceneWorkResult>;
  patchScene(input: ScenePatchInput): Promise<SceneWorkResult>;
}

export interface PiWorkerOptions {
  modelRuntime: ModelRuntime;
  /** Default coder model id (for OpenRouter a slug like `deepseek/deepseek-v4-flash`). */
  model: string;
  provider?: string;
  /** Isolated Pi agent dir (no user extensions, skills or settings). A temp dir is created when omitted. */
  agentDir?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** Enables Pi's bash tool. Bash bypasses the path guard; only enable inside an OS-level sandbox. */
  allowBash?: boolean;
  /** Allow read tools to open motion-ir.json / hyperframes.json. */
  allowProtectedReads?: boolean;
}

export interface CreatePiWorkerOptions extends Omit<PiWorkerOptions, "modelRuntime"> {
  apiKey: string;
}

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE_TOOLS = ["read", "write", "edit", "ls", "grep", "find"] as const;
const SUBMIT_TOOL = "submit_scene";

interface Submission {
  files: string[];
  notes: string;
}

export class PiWorker implements SceneWorker {
  readonly name = "pi";
  private readonly runtime: ModelRuntime;
  private readonly provider: string;
  private readonly defaultModel: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly allowBash: boolean;
  private readonly allowProtectedReads: boolean;
  private agentDir: string | undefined;

  constructor(options: PiWorkerOptions) {
    this.runtime = options.modelRuntime;
    this.provider = options.provider ?? "openrouter";
    this.defaultModel = options.model;
    this.maxTurns = options.maxTurns ?? 16;
    this.timeoutMs = options.timeoutMs ?? 6 * 60 * 1000;
    this.allowBash = options.allowBash ?? false;
    this.allowProtectedReads = options.allowProtectedReads ?? false;
    this.agentDir = options.agentDir;
  }

  /**
   * Build a worker with an in-memory credential store and the bundled model catalog (no network refresh).
   * The API key is injected as a runtime key and registered for redaction; it never enters a prompt.
   */
  static async create(options: CreatePiWorkerOptions): Promise<PiWorker> {
    if (!options.apiKey) throw new MotionError("CONFIG", "Pi worker requires a provider API key");
    registerSecret(options.apiKey);
    const provider = options.provider ?? "openrouter";
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey(provider, options.apiKey);
    return new PiWorker({ ...options, provider, modelRuntime });
  }

  static fromConfig(config: MotionConfig, overrides: Partial<CreatePiWorkerOptions> = {}): Promise<PiWorker> {
    if (!config.OPENROUTER_API_KEY)
      throw new MotionError("CONFIG", "OPENROUTER_API_KEY is required for Pi workers");
    return PiWorker.create({ apiKey: config.OPENROUTER_API_KEY, model: config.CODER_MODEL, ...overrides });
  }

  buildScene(input: SceneBuildInput): Promise<SceneWorkResult> {
    return this.run("build", input, () =>
      buildScenePrompt({
        sceneId: input.sceneId,
        sceneIR: input.sceneIR,
        context: input.context,
        contract: input.contract,
        skills: input.skills,
      }),
    );
  }

  patchScene(input: ScenePatchInput): Promise<SceneWorkResult> {
    const file = join(input.projectDir, sceneFilePath(input.sceneId));
    if (SCENE_ID.test(input.sceneId) && !existsSync(file)) {
      return Promise.reject(
        new MotionError("NOT_FOUND", `cannot patch missing ${sceneFilePath(input.sceneId)}`),
      );
    }
    return this.run("patch", input, () =>
      buildPatchPrompt({
        sceneId: input.sceneId,
        patch: input.patch,
        qaIssues: input.qaIssues,
        sceneIR: input.sceneIR,
        context: input.context,
        contract: input.contract,
        skills: input.skills,
      }),
    );
  }

  private async ensureAgentDir(): Promise<string> {
    this.agentDir ??= await mkdtemp(join(tmpdir(), "motion-pi-agent-"));
    return this.agentDir;
  }

  private validate(input: SceneTaskBase): string {
    if (!SCENE_ID.test(input.sceneId))
      throw new MotionError("VALIDATION", `invalid scene id: ${input.sceneId}`);
    if (!isAbsolute(input.projectDir)) throw new MotionError("VALIDATION", "projectDir must be absolute");
    const projectDir = resolve(input.projectDir);
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      throw new MotionError("NOT_FOUND", "projectDir does not exist");
    }
    if (input.signal?.aborted) throw new MotionError("CANCELLED", "scene task cancelled before start");
    return projectDir;
  }

  private async run(kind: "build" | "patch", input: SceneTaskBase, makePrompt: () => BuiltPrompt) {
    const projectDir = this.validate(input);
    const modelId = input.model ?? this.defaultModel;
    const model = this.runtime.getModel(this.provider, modelId);
    if (!model) {
      throw new MotionError("CONFIG", `model ${this.provider}/${modelId} is not in the Pi catalog`, {
        details: { provider: this.provider, model: modelId },
      });
    }
    const prompt = makePrompt();
    const attrs = {
      "pi.task": kind,
      "pi.model": modelId,
      "pi.provider": this.provider,
      "scene.id": input.sceneId,
    };
    const piSpan = input.span ? input.span.child("pi.execute", attrs) : startTrace("pi.execute", attrs);
    const sceneSpan = piSpan.child(`scene.${input.sceneId}`, {
      "pi.prompt_tokens_est": prompt.estimatedTokens,
      "pi.prompt_trimmed_snippets": prompt.trimmedSnippets,
    });
    const started = Date.now();
    try {
      const result = await this.execute(projectDir, input, modelId, model, prompt, sceneSpan);
      return { ...result, durationMs: Date.now() - started };
    } catch (err) {
      const error = toMotionError(err, "PROVIDER");
      sceneSpan.fail(error);
      piSpan.fail(error);
      throw error;
    } finally {
      sceneSpan.end();
      piSpan.end();
    }
  }

  private async execute(
    projectDir: string,
    input: SceneTaskBase,
    modelId: string,
    model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
    prompt: BuiltPrompt,
    span: Span,
  ): Promise<Omit<SceneWorkResult, "durationMs">> {
    const target = sceneFilePath(input.sceneId);
    const mapper = createPiTraceMapper(span, this.provider);
    const guard = createPathGuard({
      projectDir,
      writable: [target],
      allowProtectedReads: this.allowProtectedReads,
      passthroughTools: [SUBMIT_TOOL],
      allowBash: this.allowBash,
    });

    let submission: Submission | undefined;
    const submitTool = defineTool({
      name: SUBMIT_TOOL,
      label: "Submit scene",
      description: `Final action. Call once after ${target} is written. Reports the files you wrote and short notes.`,
      parameters: Type.Object({
        files: Type.Array(Type.String({ maxLength: 240 }), { minItems: 1, maxItems: 4 }),
        notes: Type.String({ maxLength: 1200 }),
      }),
      async execute(_toolCallId, params) {
        const problems: string[] = [];
        const files: string[] = [];
        for (const f of params.files) {
          const abs = resolveToolPath(f, projectDir);
          const rel = abs.slice(resolve(projectDir).length + 1).replaceAll("\\", "/");
          if (!isInsideDir(projectDir, abs) || rel.toLowerCase() !== target.toLowerCase()) {
            problems.push(`${f} is not ${target}`);
          } else if (!existsSync(abs) || statSync(abs).size === 0) {
            problems.push(`${target} does not exist or is empty`);
          } else {
            files.push(target);
          }
        }
        if (!files.includes(target) && !problems.length) problems.push(`${target} must be included`);
        if (problems.length) {
          return {
            content: [
              {
                type: "text",
                text: `Not accepted: ${problems.join("; ")}. Fix and call submit_scene again.`,
              },
            ],
            details: { accepted: false },
          };
        }
        submission = { files: [target], notes: params.notes.trim() };
        return {
          content: [{ type: "text", text: "Scene submitted." }],
          details: { accepted: true },
          terminate: true,
        };
      },
    });

    const settingsManager = SettingsManager.inMemory(
      {
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
        enableAnalytics: false,
        enableInstallTelemetry: false,
        defaultProjectTrust: "never",
        quietStartup: true,
      },
      { projectTrusted: false },
    );
    const agentDir = await this.ensureAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: projectDir,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      appendSystemPrompt: [],
      extensionFactories: [
        {
          name: "motion-path-guard",
          hidden: true,
          factory: (pi) => {
            pi.on("tool_call", (event) => {
              const decision = guard.check(event.toolName, event.input as Record<string, unknown>);
              if (!decision.block) return undefined;
              const reason = decision.reason ?? "blocked";
              mapper.recordBlocked(event.toolName, reason);
              return { block: true, reason };
            });
          },
        },
      ],
    });
    await resourceLoader.reload();
    const loadErrors = resourceLoader.getExtensions().errors;
    if (loadErrors.length) {
      throw new MotionError(
        "INTERNAL",
        `Pi path guard failed to load: ${loadErrors.map((e) => e.error).join("; ")}`,
      );
    }

    const { session } = await createAgentSession({
      cwd: projectDir,
      agentDir,
      model,
      modelRuntime: this.runtime,
      thinkingLevel: "off",
      tools: [...BASE_TOOLS, ...(this.allowBash ? ["bash"] : []), SUBMIT_TOOL],
      customTools: [submitTool],
      resourceLoader,
      sessionManager: SessionManager.inMemory(projectDir),
      settingsManager,
    });

    let stopReason: "timeout" | "turns" | "cancelled" | undefined;
    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (stopReason) return;
      stopReason = reason;
      void session.abort().catch(() => undefined);
    };
    const unsubscribe = session.subscribe((event) => {
      mapper.handle(event);
      if (event.type === "turn_start" && mapper.counters.turns > this.maxTurns) stop("turns");
    });
    const timer = setTimeout(() => stop("timeout"), this.timeoutMs);
    const onAbort = () => stop("cancelled");
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await session.prompt(prompt.text);
      await session.waitForIdle();
    } catch (err) {
      if (!submission && !stopReason) {
        throw new MotionError("PROVIDER", `Pi session failed: ${redact(toMotionError(err).message)}`, {
          retryable: true,
          cause: err,
        });
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      mapper.finish(safeStats(session));
      session.dispose();
    }

    if (submission) {
      return {
        sceneId: input.sceneId,
        files: submission.files,
        notes: submission.notes,
        runtime: this.name,
        model: modelId,
        counters: { ...mapper.counters },
      };
    }
    throw noSubmissionError(stopReason, mapper.counters, this.maxTurns, this.timeoutMs);
  }
}

function safeStats(session: AgentSession) {
  try {
    return session.getSessionStats();
  } catch {
    return undefined;
  }
}

function noSubmissionError(
  stopReason: "timeout" | "turns" | "cancelled" | undefined,
  counters: PiRunCounters,
  maxTurns: number,
  timeoutMs: number,
): MotionError {
  const details = {
    turns: counters.turns,
    toolCalls: counters.toolCalls,
    blockedCalls: counters.blockedCalls,
  };
  switch (stopReason) {
    case "cancelled":
      return new MotionError("CANCELLED", "scene task cancelled", { details });
    case "timeout":
      return new MotionError("TIMEOUT", `Pi worker exceeded ${timeoutMs}ms`, { retryable: true, details });
    case "turns":
      return new MotionError("BUDGET_EXCEEDED", `Pi worker exceeded ${maxTurns} turns`, { details });
    default:
      if (counters.lastError) {
        return new MotionError("PROVIDER", `Pi model call failed: ${counters.lastError}`, {
          retryable: true,
          details,
        });
      }
      return new MotionError("PROVIDER", "Pi worker finished without calling submit_scene", {
        retryable: true,
        details,
      });
  }
}
