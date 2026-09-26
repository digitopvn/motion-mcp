import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallerContext, MotionService } from "@motion-mcp/pipeline";
import { MotionError } from "@motion-mcp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp, staticKeyVerifier } from "../src/http-app.ts";

const KEY = "mmcp_test_key_0123456789";
const calls: Array<{ tool: string; caller: CallerContext; input: unknown }> = [];

/** Records calls so the test asserts the MCP layer's wiring, validation and error mapping only. */
const recordingService: MotionService = {
  async create(caller, input) {
    calls.push({ tool: "create", caller, input });
    return { projectId: "prj_1", jobId: "job_1", status: "queued", directorMode: "host-opus", next: "poll" };
  },
  async edit() {
    throw new MotionError("CONFLICT", "stale baseVersion");
  },
  async inspect(caller, input) {
    calls.push({ tool: "inspect", caller, input });
    return { target: input.target, directorModes: ["host-opus", "internal-opus", "custom"] };
  },
  async render() {
    throw new Error("boom with secret sk-abcdefghijklmnopqrstuvwxyz");
  },
  async search() {
    return { results: [], exact: false };
  },
  async getProject() {
    throw new MotionError("NOT_FOUND", "Project not found");
  },
  async listProjects() {
    return { projects: [] };
  },
  async publish() {
    throw new MotionError("NOT_FOUND", "Render not found");
  },
};

let server: Server;
let url: URL;

beforeAll(async () => {
  const app = createHttpApp({
    service: recordingService,
    verifyKey: staticKeyVerifier([KEY], "ws_test"),
    allowedHosts: ["127.0.0.1", "localhost"],
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function connect(token = KEY) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe("MCP protocol", () => {
  it("lists exactly the eight public tools with schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "motion_create",
      "motion_edit",
      "motion_get_project",
      "motion_inspect",
      "motion_list_projects",
      "motion_publish",
      "motion_render",
      "motion_search",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
    }
    await client.close();
  });

  it("passes the authenticated caller, never tool input, to the service", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "motion_inspect", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ target: "capabilities" });
    expect(calls.at(-1)?.caller).toMatchObject({ workspaceId: "ws_test" });
    await client.close();
  });

  it("rejects missing or wrong keys with HTTP 401", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    await expect(connect("mmcp_wrong")).rejects.toThrow();
  });

  it("returns schema violations as tool errors", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "motion_create", arguments: { brief: "x" } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it("maps domain errors to public codes and hides internal messages", async () => {
    const client = await connect();
    const conflict = await client.callTool({
      name: "motion_edit",
      arguments: { projectId: "prj_1", instruction: "slower" },
    });
    expect(conflict.structuredContent).toMatchObject({ error: { code: "conflict" } });
    const internal = await client.callTool({
      name: "motion_render",
      arguments: { projectId: "prj_1", quality: "final" },
    });
    expect(internal.isError).toBe(true);
    expect(JSON.stringify(internal)).not.toContain("sk-abcdef");
    expect(internal.structuredContent).toMatchObject({
      error: { code: "internal", message: "Internal error" },
    });
    await client.close();
  });
});
