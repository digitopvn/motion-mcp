import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDecisionClient } from "@motion-mcp/jev-router";
import { createRuntime, type PipelineRuntime, type RuntimeOverrides } from "@motion-mcp/pipeline";
import { createLogger, loadConfig } from "@motion-mcp/shared";
import { type BuildAppOptions, buildApp } from "../src/server.ts";

export const TEST_KEY = "mmcp_pipeline_test_key_0123456789";
export const SIGNING_SECRET = "test-artifact-signing-secret-0123456789";

export interface Harness {
  rt: PipelineRuntime;
  dataDir: string;
  base: URL;
  connect(token?: string): Promise<Client>;
  /** Resolve a URL handed out by the server against the test listener (PUBLIC_BASE_URL is not bound). */
  local(url: string): URL;
  close(): Promise<void>;
}

/**
 * A real runtime (file repositories, local store, JSONL ledger, HyperFrames renderer) over a temp DATA_DIR,
 * served by the real HTTP app. Model access is off unless a test injects a gateway; the decision chain is
 * rules-only so no test reaches the network.
 */
export async function startHarness(
  env: Record<string, string> = {},
  overrides: RuntimeOverrides = {},
  appOptions: BuildAppOptions = {},
): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "motion-pipeline-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    MOTION_API_KEYS: TEST_KEY,
    ARTIFACT_SIGNING_SECRET: SIGNING_SECRET,
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    DEFAULT_DIRECTOR_MODE: "host-opus",
    IMPLEMENTATION_MODE: "deterministic",
    ...env,
  });
  const rt = await createRuntime(config, {
    logger: createLogger({ service: "motion-test" }, "error"),
    gateway: null,
    sceneWorker: null,
    qaSources: [],
    decisions: createDecisionClient({ ...config, TYPESAFE_API_KEY: undefined }),
    ...overrides,
  });
  const app = buildApp(rt, appOptions);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const clients: Client[] = [];

  return {
    rt,
    dataDir,
    base,
    async connect(token = TEST_KEY) {
      const client = new Client({ name: "pipeline-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", base), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    local(url: string) {
      const u = new URL(url);
      return new URL(`${u.pathname}${u.search}`, base);
    },
    async close() {
      for (const c of clients) await c.close().catch(() => undefined);
      await rt.close(5_000);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}

export interface ToolResult {
  isError: boolean;
  data: Record<string, unknown>;
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: (res.structuredContent ?? {}) as Record<string, unknown> };
}

export async function callOk<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await call(client, name, args);
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.data)}`);
  return res.data as T;
}

export interface ProjectView {
  project: { id: string; status: string; currentVersion: number };
  job?: {
    id: string;
    state: string;
    stage?: string;
    progress: number;
    message?: string;
    error?: { code: string };
  };
  critiqueRequest?: Record<string, unknown>;
  contactSheetUrl?: string;
  renders?: Array<{ id: string; quality: string; status: string; url?: string; durationS?: number }>;
  usage?: { credits: number; costUsd: number; breakdown: Array<Record<string, unknown>> };
  trace?: string;
}

/** Poll motion_get_project until the current job reaches one of `states`. */
export async function waitForJob(
  client: Client,
  projectId: string,
  jobId: string,
  states: string[],
  timeoutMs = 240_000,
  include: string[] = [],
): Promise<ProjectView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await callOk<ProjectView>(client, "motion_get_project", { projectId, include });
    if (view.job?.id === jobId && states.includes(view.job.state)) return view;
    if (
      view.job?.id === jobId &&
      ["failed", "cancelled", "awaiting_host", "succeeded"].includes(view.job.state)
    ) {
      throw new Error(`Job ${jobId} ended ${view.job.state}: ${JSON.stringify(view.job.error)}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${jobId}: ${JSON.stringify(view.job)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
