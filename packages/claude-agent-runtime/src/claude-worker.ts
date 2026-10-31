import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createSdkMcpServer,
  type HookCallback,
  type Options,
  type Query,
  query,
  type SDKMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { type Span, startTrace } from "@motion-mcp/observability";
import {
  type BuiltPrompt,
  buildPatchPrompt,
  buildScenePrompt,
  createPathGuard,
  isInsideDir,
  type PiRunCounters,
  resolveToolPath,
  type SceneBuildInput,
  type ScenePatchInput,
  type SceneWorker,
  type SceneWorkResult,
  sceneFilePath,
  WORKER_SYSTEM_PROMPT,
} from "@motion-mcp/pi-runtime";
import { AUTH_REJECTED, MotionError, redact, registerSecret, toMotionError } from "@motion-mcp/shared";
import { z } from "zod";
import { agentEnv, createSandboxSpawn, probeSandbox, type SandboxMode } from "./sandbox.ts";
import { CLAUDE_FILE_TOOLS, checkClaudeTool } from "./tool-guard.ts";

export type QueryFn = (params: { prompt: string; options?: Options }) => Query;

export interface ClaudeSceneWorkerOptions {
  /** Workspace Anthropic API key. Passed only to the sandboxed agent process, never via `process.env`. */
  apiKey: string;
  /** Default model id, e.g. `claude-sonnet-5-5`. */
  model: string;
  maxTurns?: number;
  timeoutMs?: number;
  sandbox?: SandboxMode;
  /** CPU-seconds cap for the agent tree (default: twice the timeout). */
  cpuSeconds?: number;
  allowProtectedReads?: boolean;
  /** Test seam: replaces the SDK `query()`. */
  queryFn?: QueryFn;
  /** Override the agent binary (defaults to the SDK's bundled native binary). */
  executablePath?: string;
}

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MCP_SERVER = "motion";
const SUBMIT_TOOL = "submit_scene";
const SUBMIT_TOOL_ID = `mcp__${MCP_SERVER}__${SUBMIT_TOOL}`;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Tools Claude Code ships that a scene worker must never see, removed on top of the `tools` allowlist. */
const DENIED_TOOLS = ["Bash", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit", "Skill", "TodoWrite"];

type StopReason = "timeout" | "turns" | "cancelled";

/**
 * Scene worker backed by the Claude Agent SDK. Same contract as `PiWorker` (one scene file, guarded file
 * tools, a final `submit_scene` call) but the agent loop runs in the Claude Code binary, isolated per job:
 * scrubbed environment, private `HOME`/`CLAUDE_CONFIG_DIR`, no filesystem settings, OS sandbox, and a
 * process-group kill on abort or timeout. Costs reported by the SDK are client-side estimates.
 */
export class ClaudeSceneWorker implements SceneWorker {
  readonly name = "claude-agent-sdk";
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly sandbox: SandboxMode;
  private readonly cpuSeconds: number;
  private readonly allowProtectedReads: boolean;
  private readonly queryFn: QueryFn;
  private readonly executablePath?: string;

  constructor(options: ClaudeSceneWorkerOptions) {
    if (!options.apiKey) throw new MotionError("CONFIG", "Claude scene worker requires an Anthropic API key");
    registerSecret(options.apiKey);
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.maxTurns = options.maxTurns ?? 16;
    this.timeoutMs = options.timeoutMs ?? 6 * 60 * 1000;
    this.sandbox = options.sandbox ?? "bwrap";
    this.cpuSeconds = options.cpuSeconds ?? Math.ceil((this.timeoutMs / 1000) * 2);
    this.allowProtectedReads = options.allowProtectedReads ?? false;
    this.queryFn = options.queryFn ?? query;
    this.executablePath = options.executablePath;
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

  private validate(input: SceneBuildInput | ScenePatchInput): string {
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

  private async run(
    kind: "build" | "patch",
    input: SceneBuildInput | ScenePatchInput,
    makePrompt: () => BuiltPrompt,
  ): Promise<SceneWorkResult> {
    const projectDir = this.validate(input);
    const probe = probeSandbox(this.sandbox);
    if (!probe.ok) {
      throw new MotionError("CONFIG", `Claude worker sandbox unavailable: ${probe.reason}`, {
        details: { reason: "sandbox_unavailable", sandbox: this.sandbox },
      });
    }
    const modelId = input.model ?? this.defaultModel;
    const prompt = makePrompt();
    const attrs = {
      "claude.task": kind,
      "claude.model": modelId,
      "claude.sandbox": this.sandbox,
      "scene.id": input.sceneId,
    };
    const runSpan = input.span
      ? input.span.child("claude.execute", attrs)
      : startTrace("claude.execute", attrs);
    const sceneSpan = runSpan.child(`scene.${input.sceneId}`, {
      "claude.prompt_tokens_est": prompt.estimatedTokens,
      "claude.prompt_trimmed_snippets": prompt.trimmedSnippets,
    });
    const started = Date.now();
    try {
      const result = await this.execute(projectDir, input, modelId, prompt, sceneSpan);
      return { ...result, durationMs: Date.now() - started };
    } catch (err) {
      const error = toMotionError(err, "PROVIDER");
      sceneSpan.fail(error);
      runSpan.fail(error);
      throw error;
    } finally {
      sceneSpan.end();
      runSpan.end();
    }
  }

  private async execute(
    projectDir: string,
    input: SceneBuildInput | ScenePatchInput,
    modelId: string,
    prompt: BuiltPrompt,
    span: Span,
  ): Promise<Omit<SceneWorkResult, "durationMs">> {
    const target = sceneFilePath(input.sceneId);
    const counters: PiRunCounters = {
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      blockedCalls: 0,
      assistantMessages: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const guard = createPathGuard({
      projectDir,
      writable: [target],
      allowProtectedReads: this.allowProtectedReads,
      passthroughTools: [SUBMIT_TOOL_ID],
    });

    let submission: { files: string[]; notes: string } | undefined;
    let stopReason: StopReason | undefined;
    const abortController = new AbortController();
    let activeQuery: Query | undefined;

    const submitTool = tool(
      SUBMIT_TOOL,
      `Final action. Call once after ${target} is written. Reports the files you wrote and short notes.`,
      {
        files: z.array(z.string().max(240)).min(1).max(4),
        notes: z.string().max(1200),
      },
      async (params) => {
        const problems: string[] = [];
        const files: string[] = [];
        for (const f of params.files) {
          const abs = resolveToolPath(f, projectDir);
          const rel = abs.slice(projectDir.length + 1).replaceAll("\\", "/");
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
            isError: true,
          };
        }
        submission = { files: [target], notes: params.notes.trim() };
        // The scene is in; end the run instead of letting the agent keep going.
        setImmediate(() => void activeQuery?.interrupt().catch(() => undefined));
        return { content: [{ type: "text", text: "Scene submitted." }] };
      },
    );

    const guardHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      const decision = checkClaudeTool(guard, hookInput.tool_name, hookInput.tool_input);
      if (!decision.block) return {};
      const reason = decision.reason ?? "blocked";
      counters.blockedCalls++;
      span.setAttributes({
        "claude.last_blocked": redact(`${hookInput.tool_name}: ${reason}`).slice(0, 200),
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    };

    const homeDir = await mkdtemp(join(tmpdir(), "motion-claude-"));
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    const compositionsDir = join(projectDir, "compositions");
    await mkdir(compositionsDir, { recursive: true });
    const stderrTail: string[] = [];
    const sandbox = createSandboxSpawn({
      mode: this.sandbox,
      projectDir,
      writableDirs: [compositionsDir],
      homeDir,
      cpuSeconds: this.cpuSeconds,
      maxFileBytes: MAX_FILE_BYTES,
      onStderr: (line) => {
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail.shift();
      },
    });

    const stop = (reason: StopReason) => {
      if (stopReason || submission) return;
      stopReason = reason;
      abortController.abort();
    };
    const timer = setTimeout(() => stop("timeout"), this.timeoutMs);
    const onAbort = () => stop("cancelled");
    input.signal?.addEventListener("abort", onAbort, { once: true });

    let authFailure = false;
    let resultErrors: string[] = [];
    let resultSubtype: string | undefined;
    try {
      activeQuery = this.queryFn({
        prompt: prompt.text,
        options: {
          abortController,
          cwd: projectDir,
          model: modelId,
          systemPrompt: WORKER_SYSTEM_PROMPT,
          tools: [...CLAUDE_FILE_TOOLS],
          allowedTools: [...CLAUDE_FILE_TOOLS, SUBMIT_TOOL_ID],
          disallowedTools: DENIED_TOOLS,
          permissionMode: "dontAsk",
          mcpServers: { [MCP_SERVER]: createSdkMcpServer({ name: MCP_SERVER, tools: [submitTool] }) },
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          maxTurns: this.maxTurns,
          env: agentEnv({ apiKey: this.apiKey, homeDir }),
          hooks: { PreToolUse: [{ hooks: [guardHook] }] },
          spawnClaudeCodeProcess: sandbox.spawn,
          ...(this.executablePath ? { pathToClaudeCodeExecutable: this.executablePath } : {}),
        },
      });
      for await (const message of activeQuery) {
        const outcome = this.record(message, counters, span);
        if (outcome.authFailure) authFailure = true;
        if (outcome.result) {
          resultSubtype = outcome.result.subtype;
          resultErrors = outcome.result.errors;
        }
      }
    } catch (err) {
      if (!submission && !stopReason) {
        throw new MotionError(
          "PROVIDER",
          `Claude agent failed: ${redact(toMotionError(err).message)}${stderrTail.length ? ` (${stderrTail.at(-1)})` : ""}`,
          {
            retryable: !authFailure,
            cause: err,
            details: authFailure ? { reason: AUTH_REJECTED } : undefined,
          },
        );
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      activeQuery?.close();
      sandbox.killAll();
      await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
      span.setAttributes({
        "claude.turns": counters.turns,
        "claude.tool_calls": counters.toolCalls,
        "claude.blocked_calls": counters.blockedCalls,
        "claude.cost_estimated": true,
      });
    }

    if (submission) {
      return {
        sceneId: input.sceneId,
        files: submission.files,
        notes: submission.notes,
        runtime: this.name,
        model: modelId,
        counters: { ...counters },
      };
    }
    if (!stopReason && resultSubtype === "error_max_turns") stopReason = "turns";
    const details = {
      turns: counters.turns,
      toolCalls: counters.toolCalls,
      blockedCalls: counters.blockedCalls,
    };
    if (authFailure) {
      throw new MotionError("PROVIDER", "Anthropic rejected the workspace API key", {
        details: { ...details, reason: AUTH_REJECTED },
      });
    }
    switch (stopReason) {
      case "cancelled":
        throw new MotionError("CANCELLED", "scene task cancelled", { details });
      case "timeout":
        throw new MotionError("TIMEOUT", `Claude worker exceeded ${this.timeoutMs}ms`, {
          retryable: true,
          details,
        });
      case "turns":
        throw new MotionError("BUDGET_EXCEEDED", `Claude worker exceeded ${this.maxTurns} turns`, {
          details,
        });
      default: {
        const why = counters.lastError ?? resultErrors[0];
        throw new MotionError(
          "PROVIDER",
          why
            ? `Claude worker failed: ${redact(why).slice(0, 300)}`
            : "Claude worker finished without calling submit_scene",
          { retryable: true, details },
        );
      }
    }
  }

  /** Fold one SDK message into counters and the trace span. */
  private record(
    message: SDKMessage,
    counters: PiRunCounters,
    span: Span,
  ): { authFailure?: boolean; result?: { subtype: string; errors: string[] } } {
    if (message.type === "assistant") {
      if (message.parent_tool_use_id) return {};
      counters.assistantMessages++;
      for (const block of message.message.content) {
        if (block.type === "tool_use") counters.toolCalls++;
      }
      if (message.error) {
        counters.lastError = message.error;
        return {
          authFailure: message.error === "authentication_failed" || message.error === "billing_error",
        };
      }
      return {};
    }
    if (message.type === "user") {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block &&
            "type" in block &&
            block.type === "tool_result" &&
            block.is_error
          ) {
            counters.toolErrors++;
          }
        }
      }
      return {};
    }
    if (message.type === "result") {
      counters.turns = message.num_turns;
      counters.lastStopReason = message.stop_reason ?? message.subtype;
      for (const [model, usage] of Object.entries(message.modelUsage ?? {})) {
        const cacheReadTokens = usage.cacheReadInputTokens ?? 0;
        const cacheWriteTokens = usage.cacheCreationInputTokens ?? 0;
        const inputTokens = usage.inputTokens + cacheReadTokens + cacheWriteTokens;
        counters.inputTokens += inputTokens;
        counters.outputTokens += usage.outputTokens;
        counters.costUsd += usage.costUSD;
        // The SDK's cost is a client-side estimate; the workspace's Anthropic invoice is authoritative.
        span.recordModelCall({
          model,
          provider: "anthropic-agent-sdk",
          inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          costUsd: usage.costUSD,
        });
      }
      return {
        result: { subtype: message.subtype, errors: message.subtype === "success" ? [] : message.errors },
      };
    }
    return {};
  }
}
