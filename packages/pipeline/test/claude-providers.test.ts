import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRepository } from "@motion-mcp/database";
import { ScriptedGateway } from "@motion-mcp/llm";
import type { SceneWorker } from "@motion-mcp/pi-runtime";
import { AUTH_REJECTED, createLogger, MotionError, SealedBox } from "@motion-mcp/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceClaude } from "../src/claude-providers.ts";

const KEY = "sk-ant-api03-workspace-claude-unit-test-key-000000001";
const WS = "ws_claude_unit";
const config = {
  CLAUDE_DIRECTOR_MODEL: "claude-opus-5-5",
  CLAUDE_CRITIC_MODEL: "claude-opus-5-5",
  CLAUDE_WORKER_MODEL: "claude-sonnet-5-5",
  CLAUDE_MODELS: "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5",
  CLAUDE_WORKER_SANDBOX: "bwrap" as const,
  CLAUDE_WORKER_MAX_TURNS: 16,
  CLAUDE_WORKER_TIMEOUT_MS: 360_000,
};

let dir: string;
let repos: FileRepository;
let sandboxOk: boolean;
let reject: boolean;
const workers: Array<{ apiKey: string; model: string }> = [];

const rejection = () =>
  new MotionError("PROVIDER", "invalid x-api-key", { details: { reason: AUTH_REJECTED } });

function claude(box: SealedBox | null = new SealedBox("7b".repeat(32))) {
  return new WorkspaceClaude({
    repos,
    box: box ?? undefined,
    logger: createLogger({ service: "test" }, "error"),
    config,
    workersAllowed: true,
    createGateway: () => {
      const scripted = new ScriptedGateway(["{}"]);
      return {
        complete: async (request) => {
          if (reject) throw rejection();
          return scripted.complete(request);
        },
        verifyKey: async () => {
          if (reject) throw rejection();
        },
      };
    },
    createWorker: (options) => {
      workers.push(options);
      const worker: SceneWorker = {
        name: "claude-agent-sdk",
        buildScene: async () => {
          throw rejection();
        },
        patchScene: async () => {
          throw rejection();
        },
      };
      return worker;
    },
    probe: () =>
      sandboxOk ? { ok: true, mode: "bwrap" } : { ok: false, mode: "bwrap", reason: "no userns" },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-unit-"));
  repos = FileRepository.fromDataDir(dir);
  await repos.workspaces.create({ id: WS, name: "W", ownerUserId: "usr_1" });
  sandboxOk = true;
  reject = false;
  workers.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceClaude", () => {
  it("pins nothing while every role uses the server defaults", async () => {
    const c = claude();
    await c.setKey(WS, KEY);
    expect(await c.snapshot(WS)).toBeUndefined();
    expect(await c.directorAvailable(WS)).toBe(false);
    expect(await c.resolve(WS, undefined)).toEqual({ unavailable: {}, warnings: [] });
  });

  it("resolves pinned roles to the workspace key and model", async () => {
    const c = claude();
    await c.setKey(WS, KEY);
    await c.updateSettings(WS, {
      director: "anthropic-api",
      critic: "anthropic-api",
      sceneWorker: "claude-agent-sdk",
      criticModel: "claude-haiku-5-5",
    });
    const selection = await c.snapshot(WS);
    expect(selection).toMatchObject({ director: "anthropic-api", criticModel: "claude-haiku-5-5" });
    const resolved = await c.resolve(WS, selection);
    expect(resolved.director).toMatchObject({ model: "claude-opus-5-5", byok: true });
    expect(resolved.critic).toMatchObject({ model: "claude-haiku-5-5", byok: true });
    expect(resolved.worker?.name).toBe("claude-agent-sdk");
    expect(workers).toEqual([{ apiKey: KEY, model: "claude-sonnet-5-5" }]);
    expect(resolved.warnings).toEqual([]);
  });

  it("keeps the selection pinned at enqueue even if settings change later", async () => {
    const c = claude();
    await c.setKey(WS, KEY);
    await c.updateSettings(WS, { director: "anthropic-api" });
    const pinned = await c.snapshot(WS);
    await c.updateSettings(WS, { director: "openrouter" });
    expect((await c.resolve(WS, pinned)).director?.model).toBe("claude-opus-5-5");
  });

  it("fails the role with fallback none and warns with fallback server when the key is gone", async () => {
    const c = claude();
    await c.setKey(WS, KEY);
    await c.updateSettings(WS, { director: "anthropic-api", sceneWorker: "claude-agent-sdk" });
    const strict = await c.snapshot(WS);
    await c.updateSettings(WS, { fallback: "server" });
    const lenient = await c.snapshot(WS);
    await c.deleteKey(WS);

    const none = await c.resolve(WS, strict);
    expect(none.director).toBeUndefined();
    expect(none.unavailable.director?.details).toMatchObject({ reason: "claude_key_unavailable" });
    expect(none.worker).toBeNull();

    const server = await c.resolve(WS, lenient);
    expect(server.director).toBeUndefined();
    expect(server.unavailable).toEqual({});
    expect(server.worker).toBeUndefined();
    expect(server.warnings).toHaveLength(2);
  });

  it("refuses the Claude worker without a sandbox and falls back to deterministic", async () => {
    const c = claude();
    await c.setKey(WS, KEY);
    sandboxOk = false;
    await expect(c.updateSettings(WS, { sceneWorker: "claude-agent-sdk" })).rejects.toThrow(/unavailable/);
    sandboxOk = true;
    await c.updateSettings(WS, { sceneWorker: "claude-agent-sdk" });
    sandboxOk = false;
    const resolved = await c.resolve(WS, await c.snapshot(WS));
    expect(resolved.worker).toBeNull();
    expect(resolved.warnings[0]).toMatch(/sandbox unavailable/);
  });

  it("marks the key revoked when Anthropic rejects it mid-job", async () => {
    const c = claude();
    await c.setKey(WS, KEY);
    await c.updateSettings(WS, { director: "anthropic-api", sceneWorker: "claude-agent-sdk" });
    const resolved = await c.resolve(WS, await c.snapshot(WS));
    await expect(resolved.worker?.buildScene({} as Parameters<SceneWorker["buildScene"]>[0])).rejects.toThrow(
      /invalid/,
    );
    expect((await c.overview(WS)).status).toBe("revoked");
    expect(await c.directorAvailable(WS)).toBe(false);
    const after = await c.resolve(WS, await c.snapshot(WS));
    expect(after.unavailable.director).toBeDefined();
  });

  it("does not mark a newly saved key revoked when a job still running on the old key fails", async () => {
    const c = claude();
    await c.setKey(WS, KEY);
    await c.updateSettings(WS, { sceneWorker: "claude-agent-sdk" });
    const resolved = await c.resolve(WS, await c.snapshot(WS));
    await new Promise((r) => setTimeout(r, 5));
    await c.setKey(WS, `${KEY.slice(0, -1)}2`);
    await expect(resolved.worker?.buildScene({} as Parameters<SceneWorker["buildScene"]>[0])).rejects.toThrow(
      /invalid/,
    );
    expect((await c.overview(WS)).status).toBe("connected");
  });

  it("reports unavailable without an encryption key and blocks subscription sign-in", async () => {
    const view = await claude(null).overview(WS);
    expect(view.status).toBe("unavailable");
    expect(view.subscription.status).toBe("blocked_by_policy");
    reject = true;
    await expect(claude().setKey(WS, KEY)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await repos.providerCredentials.get(WS, "claude", "anthropic")).toBeUndefined();
  });
});
