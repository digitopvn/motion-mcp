import { type AuthInfo, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { CallerContext, MotionService } from "@motion-mcp/pipeline";
import * as S from "@motion-mcp/pipeline";
import { type Logger, type MotionErrorCode, redactDeep, toMotionError } from "@motion-mcp/shared";
import type { z } from "zod";

export const SERVER_NAME = "motion-mcp";
export const SERVER_VERSION = "0.1.0";

export const PUBLIC_ERROR_CODES: Record<MotionErrorCode, string> = {
  VALIDATION: "invalid_input",
  LINT: "invalid_input",
  NOT_FOUND: "not_found",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "unauthorized",
  CONFLICT: "conflict",
  INSUFFICIENT_CREDITS: "insufficient_credits",
  BUDGET_EXCEEDED: "budget_exceeded",
  RATE_LIMITED: "rate_limited",
  PROVIDER: "provider_unavailable",
  TIMEOUT: "provider_unavailable",
  RENDER: "internal",
  CONFIG: "internal",
  CANCELLED: "internal",
  INTERNAL: "internal",
};

/** Caller context travels through the SDK as `authInfo.extra`, set by our HTTP auth layer. */
export function callerFromAuth(authInfo: AuthInfo | undefined): CallerContext {
  const caller = authInfo?.extra?.caller as CallerContext | undefined;
  if (!caller?.workspaceId) throw toMotionError(new Error("Missing caller context"), "UNAUTHORIZED");
  return caller;
}

export function authInfoFor(caller: CallerContext, token: string): AuthInfo {
  return { token, clientId: caller.keyId, scopes: ["mcp"], extra: { caller } };
}

interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  readOnly: boolean;
  run: (service: MotionService, caller: CallerContext, input: z.output<I>) => Promise<z.output<O>>;
}

function tool<I extends z.ZodType, O extends z.ZodType>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

export const PUBLIC_TOOLS = [
  tool({
    name: "motion_create",
    title: "Create motion video",
    description:
      "Start a new motion video from a brief. Returns a job to poll with motion_get_project. " +
      "If you are a strong creative model, call motion_inspect {target:'capabilities'} first and pass " +
      "directorMode 'host-opus' with your own creativeSpec so the server does not pay for a second director.",
    input: S.CreateInput,
    output: S.CreateOutput,
    readOnly: false,
    run: (s, c, i) => s.create(c, i),
  }),
  tool({
    name: "motion_edit",
    title: "Edit motion video",
    description:
      "Revise a project with a free-text instruction or structured scenePatches, or answer a host critique " +
      "request (critiqueRequestId). Only affected scenes are rebuilt.",
    input: S.EditInput,
    output: S.EditOutput,
    readOnly: false,
    run: (s, c, i) => s.edit(c, i),
  }),
  tool({
    name: "motion_inspect",
    title: "Inspect capabilities, project, scene or styles",
    description:
      "target 'capabilities' (default) returns director modes, CreativeSpec/ScenePatch JSON Schemas, " +
      "pricing and limits (the director handshake). 'project'/'scene' return Motion IR, QA issues and frames. " +
      "'styles' lists style presets.",
    input: S.InspectInput,
    output: S.InspectOutput,
    readOnly: true,
    run: (s, c, i) => s.inspect(c, i),
  }),
  tool({
    name: "motion_render",
    title: "Render video",
    description: "Render a project version at preview (draft) or final quality. Returns a job to poll.",
    input: S.RenderInput,
    output: S.RenderOutput,
    readOnly: false,
    run: (s, c, i) => s.render(c, i),
  }),
  tool({
    name: "motion_search",
    title: "Search projects, scenes, styles and patterns",
    description: "Hybrid search across your projects and the motion domain pack.",
    input: S.SearchInput,
    output: S.SearchOutput,
    readOnly: true,
    run: (s, c, i) => s.search(c, i),
  }),
  tool({
    name: "motion_get_project",
    title: "Get project status",
    description:
      "Project state, current job progress, pending host critique request, renders with download URLs, " +
      "and optionally versions, usage, trace or the Motion IR.",
    input: S.GetProjectInput,
    output: S.GetProjectOutput,
    readOnly: true,
    run: (s, c, i) => s.getProject(c, i),
  }),
  tool({
    name: "motion_list_projects",
    title: "List projects",
    description: "List projects in your workspace, newest first.",
    input: S.ListProjectsInput,
    output: S.ListProjectsOutput,
    readOnly: true,
    run: (s, c, i) => s.listProjects(c, i),
  }),
  tool({
    name: "motion_publish",
    title: "Publish render",
    description: "Publish a succeeded final render at a stable share URL.",
    input: S.PublishInput,
    output: S.PublishOutput,
    readOnly: false,
    run: (s, c, i) => s.publish(c, i),
  }),
] as const;

/** Builds the stateless Streamable HTTP handler exposing exactly the eight public tools. */
export function createMotionMcpHandler(service: MotionService, logger?: Logger) {
  return createMcpHandler((ctx) => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        instructions:
          "Motion MCP produces motion videos. Call motion_inspect first for the capability handshake. " +
          "Long operations return a jobId; poll motion_get_project until succeeded, failed or awaiting_host.",
      },
    );
    for (const def of PUBLIC_TOOLS) {
      const d = def as unknown as ToolDef<z.ZodType, z.ZodType>;
      server.registerTool(
        d.name,
        {
          title: d.title,
          description: d.description,
          inputSchema: d.input,
          outputSchema: d.output,
          annotations: { readOnlyHint: d.readOnly, openWorldHint: false, destructiveHint: false },
        },
        async (args: unknown) => {
          try {
            const caller = callerFromAuth(ctx.authInfo);
            const result = await d.run(service, caller, args);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result as Record<string, unknown>,
            };
          } catch (err) {
            const e = toMotionError(err);
            const code = PUBLIC_ERROR_CODES[e.code] ?? "internal";
            const error = {
              code,
              message: code === "internal" ? "Internal error" : e.message,
              ...(e.details && code !== "internal" ? { details: redactDeep(e.details) } : {}),
            };
            logger?.warn("tool.error", { tool: d.name, code: e.code, message: e.message });
            return {
              isError: true,
              content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
              structuredContent: { error },
            };
          }
        },
      );
    }
    return server;
  });
}
