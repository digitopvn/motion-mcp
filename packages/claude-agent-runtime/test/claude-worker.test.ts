import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { startTrace } from "@motion-mcp/observability";
import { AUTH_REJECTED, MotionError } from "@motion-mcp/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { context, scene } from "../../pi-runtime/test/fixtures.ts";
import { ClaudeSceneWorker, type QueryFn } from "../src/index.ts";

// Offline: the SDK's MCP server factory is reduced to a plain object so the fake `query()` can call the
// submit tool's handler directly. Hooks, guard, env and option wiring are the worker's real code.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...original,
    createSdkMcpServer: (o: { name: string; tools: unknown[] }) => ({
      type: "sdk",
      name: o.name,
      tools: o.tools,
    }),
  };
});

const KEY = "sk-ant-api03-worker0000000000000000000000";
const base = mkdtempSync(join(tmpdir(), "claude-worker-test-"));
let projectDir: string;
const html = '<template><div data-composition-id="intro" data-start="0" data-duration="4"></div></template>';

beforeEach(() => {
  projectDir = mkdtempSync(join(base, "project-"));
  writeFileSync(join(projectDir, "motion-ir.json"), '{"secret":"do not read"}');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

interface SubmitTool {
  name: string;
  handler: (args: { files: string[]; notes: string }, extra: unknown) => Promise<{ isError?: boolean }>;
}

interface Step {
  /** Tool call the fake agent attempts; the PreToolUse hook decides, then `apply` runs if allowed. */
  tool?: { name: string; input: Record<string, unknown>; apply?: () => void };
  submit?: { files: string[]; notes: string };
  message?: SDKMessage;
  /** Wait for abort (simulates a hung agent). */
  hang?: boolean;
}

interface Recorded {
  options?: Options;
  decisions: Array<{ tool: string; denied: boolean; reason?: string }>;
  submitResults: Array<{ isError?: boolean }>;
}

function result(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 3,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0.012,
    usage: {},
    modelUsage: {
      "claude-sonnet-5-5": {
        inputTokens: 900,
        outputTokens: 300,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.012,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
    permission_denials: [],
    uuid: "u",
    session_id: "s",
    ...overrides,
  } as unknown as SDKMessage;
}

function fakeQuery(steps: Step[], recorded: Recorded): QueryFn {
  return ({ options }) => {
    recorded.options = options;
    const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const server = options?.mcpServers?.motion as unknown as { tools: SubmitTool[] };
    const signal = options?.abortController?.signal as AbortSignal;
    let interrupted = false;
    async function* run(): AsyncGenerator<SDKMessage> {
      for (const step of steps) {
        // After interrupt() the real SDK still ends the turn with a result message.
        if (interrupted && !step.message) continue;
        if (step.hang) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw new Error("Claude Code process aborted by user");
        }
        if (step.tool) {
          const out = (await hook(
            {
              hook_event_name: "PreToolUse",
              tool_name: step.tool.name,
              tool_input: step.tool.input,
              tool_use_id: "t",
              session_id: "s",
              transcript_path: "",
              cwd: projectDir,
            } as never,
            "t",
            { signal },
          )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
          const denied = out.hookSpecificOutput?.permissionDecision === "deny";
          recorded.decisions.push({
            tool: step.tool.name,
            denied,
            reason: out.hookSpecificOutput?.permissionDecisionReason,
          });
          if (!denied) step.tool.apply?.();
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              content: [{ type: "tool_use", id: "t", name: step.tool.name, input: step.tool.input }],
            },
          } as unknown as SDKMessage;
        }
        if (step.submit) {
          const submit = server.tools.find((t) => t.name === "submit_scene") as SubmitTool;
          recorded.submitResults.push(await submit.handler(step.submit, {}));
          await new Promise((r) => setImmediate(r));
        }
        if (step.message) yield step.message;
      }
    }
    const generator = run();
    return Object.assign(generator, {
      interrupt: async () => {
        interrupted = true;
      },
      close: () => undefined,
    }) as unknown as Query;
  };
}

const worker = (steps: Step[], recorded: Recorded, opts: { maxTurns?: number; timeoutMs?: number } = {}) =>
  new ClaudeSceneWorker({
    apiKey: KEY,
    model: "claude-sonnet-5-5",
    sandbox: "none",
    queryFn: fakeQuery(steps, recorded),
    ...opts,
  });

const fresh = (): Recorded => ({ decisions: [], submitResults: [] });

describe("ClaudeSceneWorker.buildScene", () => {
  it("guards tools, validates submit_scene, isolates the agent and traces estimated cost", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-ambient-should-not-leak-0000");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example.com");
    const rec = fresh();
    const target = () => join(projectDir, "compositions", "intro.html");
    const steps: Step[] = [
      { tool: { name: "Write", input: { file_path: "../escape.html", content: "x" } } },
      { tool: { name: "Read", input: { file_path: join(projectDir, "motion-ir.json") } } },
      { tool: { name: "Bash", input: { command: "cat ~/.claude/credentials" } } },
      { tool: { name: "Glob", input: { pattern: "/etc/**" } } },
      { submit: { files: ["compositions/intro.html"], notes: "early" } },
      {
        tool: {
          name: "Write",
          input: { file_path: join(projectDir, "compositions/intro.html"), content: html },
          apply: () => writeFileSync(target(), html),
        },
      },
      { tool: { name: "Grep", input: { pattern: "data-start", path: "compositions" } } },
      { submit: { files: ["compositions/intro.html"], notes: "Built the intro reveal." } },
      { message: result() },
    ];
    const span = startTrace("job");
    const out = await worker(steps, rec).buildScene({
      projectDir,
      sceneId: "intro",
      sceneIR: scene,
      context,
      span,
    });
    span.end();
    vi.unstubAllEnvs();

    expect(rec.decisions).toEqual([
      expect.objectContaining({ tool: "Write", denied: true }),
      expect.objectContaining({ tool: "Read", denied: true }),
      expect.objectContaining({ tool: "Bash", denied: true }),
      expect.objectContaining({ tool: "Glob", denied: true }),
      { tool: "Write", denied: false, reason: undefined },
      { tool: "Grep", denied: false, reason: undefined },
    ]);
    expect(rec.submitResults[0]?.isError).toBe(true);
    expect(out).toMatchObject({
      sceneId: "intro",
      files: ["compositions/intro.html"],
      notes: "Built the intro reveal.",
      runtime: "claude-agent-sdk",
      model: "claude-sonnet-5-5",
    });
    expect(out.counters).toMatchObject({
      turns: 3,
      toolCalls: 6,
      blockedCalls: 4,
      inputTokens: 1000,
      costUsd: 0.012,
    });

    const o = rec.options as Options;
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
    expect(o.disallowedTools).toContain("Bash");
    expect(o.strictMcpConfig).toBe(true);
    expect(o.env?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(o.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(o.env?.CLAUDE_CONFIG_DIR).toMatch(/motion-claude-.*\/\.claude$/);
    expect(o.env?.HOME).not.toBe(process.env.HOME);
    // The per-job home is removed after the run.
    expect(existsSync(o.env?.HOME as string)).toBe(false);

    const json = JSON.stringify(span.data);
    expect(json).toContain("claude.execute");
    expect(json).toContain("anthropic-agent-sdk");
    expect(json).not.toContain(KEY);
  });

  it("maps an authentication failure to auth_rejected without retrying", async () => {
    const rec = fresh();
    const steps: Step[] = [
      {
        message: {
          type: "assistant",
          parent_tool_use_id: null,
          error: "authentication_failed",
          message: { content: [{ type: "text", text: "Invalid API key" }] },
        } as unknown as SDKMessage,
      },
      {
        message: result({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["auth"],
          num_turns: 1,
        }),
      },
    ];
    const err = await worker(steps, rec)
      .buildScene({ projectDir, sceneId: "intro", sceneIR: scene, context })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotionError);
    expect(err).toMatchObject({ code: "PROVIDER", retryable: false, details: { reason: AUTH_REJECTED } });
  });

  it("reports turn limits, timeouts and cancellation with typed errors", async () => {
    const turns = await worker([{ message: result({ subtype: "error_max_turns", errors: [] }) }], fresh(), {
      maxTurns: 2,
    })
      .buildScene({ projectDir, sceneId: "intro", sceneIR: scene, context })
      .catch((e: unknown) => e);
    expect(turns).toMatchObject({ code: "BUDGET_EXCEEDED" });

    const timeout = await worker([{ hang: true }], fresh(), { timeoutMs: 50 })
      .buildScene({ projectDir, sceneId: "intro", sceneIR: scene, context })
      .catch((e: unknown) => e);
    expect(timeout).toMatchObject({ code: "TIMEOUT" });

    const controller = new AbortController();
    const pending = worker([{ hang: true }], fresh())
      .buildScene({ projectDir, sceneId: "intro", sceneIR: scene, context, signal: controller.signal })
      .catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ code: "CANCELLED" });
  });

  it("fails clearly when the agent never submits", async () => {
    const err = await worker([{ message: result() }], fresh())
      .buildScene({ projectDir, sceneId: "intro", sceneIR: scene, context })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PROVIDER", message: expect.stringContaining("submit_scene") });
  });

  it("validates inputs before spawning anything", async () => {
    const rec = fresh();
    const w = worker([], rec);
    await expect(w.buildScene({ projectDir, sceneId: "../x", sceneIR: scene })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(w.patchScene({ projectDir, sceneId: "intro" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rec.options).toBeUndefined();
    expect(() => new ClaudeSceneWorker({ apiKey: "", model: "m" })).toThrow(/API key/);
  });

  it("patches an existing scene", async () => {
    mkdirSync(join(projectDir, "compositions"), { recursive: true });
    writeFileSync(join(projectDir, "compositions", "intro.html"), html);
    const rec = fresh();
    const out = await worker(
      [{ submit: { files: ["compositions/intro.html"], notes: "Fixed overflow." } }, { message: result() }],
      rec,
    ).patchScene({ projectDir, sceneId: "intro", sceneIR: scene, context });
    expect(out.notes).toBe("Fixed overflow.");
  });
});
