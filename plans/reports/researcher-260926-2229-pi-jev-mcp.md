# Research: Pi runtime, "Jev" model, MCP TS SDK + OpenRouter (2026-09-26)

## Bottom line
1. **Pi moved.** `@mariozechner/pi-*` is deprecated at 0.73.1 (npm message: "please use @earendil-works/..."). Use `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-agent-core`, all at **0.87.1** (published 2026-09-22, Node >=22.19). The repo is now `earendil-works/pi` (the badlogic/pi-mono URL redirects there). Embed Pi through the in-process SDK (`createAgentSession`), not RPC. Use RPC only if you need process isolation.
2. **Jev cannot be the coding model.** TypeSafe's Jev is a "System One" decision model. It returns typed choice, score, or noul (0–1 probability) answers, and TypeSafe's docs say it does "not write replies, produce code". On OpenRouter it appears only as `typesafe/jev-router`, a router listed 2026-09-25 that forwards chat requests to other models. Keep the model id configurable. Default to a cheap, known coding model, and treat Jev Router as an opt-in experiment.
3. **MCP SDK: build on v2.** `@modelcontextprotocol/server` is at 2.1.0 (2026-09-23) and implements the stateless 2026-07-28 spec. Its `createMcpHandler` serves 2025-era clients statelessly by default. `@modelcontextprotocol/sdk` 1.30.1 is the v1.x maintenance line, so do not start new code on it.
4. **OpenRouter:** the Claude Opus 5.5 id is `anthropic/claude-opus-5.5`, priced at $4/M input and $20/M output with a 1M context and support for `structured_outputs`.

Sources: npm registry (`npm view`), cloned repos `earendil-works/pi@2b0a123` (2026-09-26) and `modelcontextprotocol/typescript-sdk` (2026-09-23), `bestagentkits/pi-multix@6943a18`, the public `openrouter.ai/api/v1/models` endpoint (458 models, fetched 2026-09-26), docs.typesafe.ai, OpenRouter docs, and press coverage (runtimewire, datacamp). Official sources and source code are weighted above articles.

## A. Pi as headless execution runtime

### SDK embedding (recommended)
```ts
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager,
  DefaultResourceLoader, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

const cwd = "/work/projects/<projectId>";                 // scoped workspace
const modelRuntime = await ModelRuntime.create({ authPath: "/srv/pi/auth.json", modelsPath: "/srv/pi/models.json" });
await modelRuntime.setRuntimeApiKey("openrouter", process.env.OPENROUTER_API_KEY!);
const model = modelRuntime.getModel("openrouter", process.env.PI_MODEL_ID!); // e.g. "deepseek/deepseek-v4-flash"

const submitScene = defineTool({                           // structured final result
  name: "submit_scene", label: "Submit scene", description: "Final action: report written files.",
  parameters: Type.Object({ files: Type.Array(Type.String()), notes: Type.String() }),
  async execute(_id, params) { return { content: [{ type: "text", text: "ok" }], details: params, terminate: true }; },
});

const { session } = await createAgentSession({
  cwd, model, modelRuntime, thinkingLevel: "off",
  tools: ["read", "write", "edit", "bash"],               // allow-list of built-ins
  customTools: [submitScene],
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
  resourceLoader: new DefaultResourceLoader({ cwd, agentDir: "/srv/pi", /* skillsOverride: ... */ }),
});
const off = session.subscribe((e) => {
  if (e.type === "tool_execution_start") log(e.toolName, e.args);
  if (e.type === "message_end" && e.message.role === "assistant") log(e.message.usage); // tokens + cost
});
try { await session.prompt(taskPrompt); const stats = session.getSessionStats(); /* tokens{...}, cost */ }
finally { off(); session.dispose(); }
```
- **Model/provider.** OpenRouter is a built-in provider that reads `OPENROUTER_API_KEY`. Model ids are OpenRouter slugs such as `provider/model`. The CLI equivalent is `--provider openrouter --model <id>`. Pi ships a bundled catalog and refreshes it from pi.dev. For an id missing from the catalog, add it under `providers.openrouter.models` in `models.json`.
- **Tools.** The built-ins are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and `powershell` (Windows). `tools` is an allow-list, and `excludeTools` and `noTools` are also available. The CLI flags are `--tools read,write,edit,bash`, `-xt`, and `-nt`.
- **Custom tools.** Pass them either through `customTools` on the SDK or through an extension's `pi.registerTool(defineTool({...}))`. Parameters use TypeBox (`Type.Object`), not zod. Set `terminate: true` so the run can end on a "submit" tool call without paying for another LLM turn (see the repo's `examples/extensions/structured-output.ts`). **This is how Pi returns structured results.** JSON mode only structures the event stream, not the model's answer.
- **Extensions.** An extension is a TS module whose default export is `(pi: ExtensionAPI) => void`, loaded through `jiti` so no build step is needed. Key hooks are `pi.on("tool_call")`, which can mutate input or return `{ block: true, reason }` (see `protected-paths.ts`), `tool_result`, `before_agent_start`, and `agent_settled`. To use inline factories, pass them through `DefaultResourceLoader`.
- **Skills.** Pi follows the agentskills.io spec: a directory containing `SKILL.md` with `name` and `description` frontmatter. Only the name, description, and path go into the system prompt, and the model reads the full `SKILL.md` on demand. Skills are discovered from `cwd/.pi/skills`, `~/.pi/agent/skills`, and project `.agents/skills`. `--skill <path>`, `--no-skills`, or the SDK `skillsOverride` / a custom `ResourceLoader` pin an exact set. Recommendation: ship a HyperFrames skill and inject it explicitly rather than relying on discovery.
- **Workspace scoping (security).** `cwd` controls resource discovery, context files, and default tool paths. It is **not a sandbox**: `docs/security.md` says `bash` and the other tools can reach any path the process can. For multi-tenant use, run each job in a container or VM, or as a restricted OS user. A `tool_call` guard that rejects paths outside `cwd` is useful but not sufficient, because `bash` bypasses it. Project-local `.pi/` resources load only after the project is trusted (`-a`/`-na`), so pass `--no-approve` or its SDK equivalent for untrusted workspaces.

### CLI modes (process boundary)
- `pi -p "task"` prints the final text and exits nonzero on an error or abort.
- `pi --mode json "task"` streams JSONL events and exits. The output is a session header followed by `agent_start`, `turn_start`, `message_start`, `message_update` (deltas plus cumulative `usage` with `cost`), `tool_execution_start/update/end` (`toolCallId`, `toolName`, `args`, `result`, `isError`), `message_end` (the authoritative message), `turn_end`, `agent_end`, and finally `agent_settled`, which is the real done signal. An error or abort does **not** set a nonzero exit code in this mode, so inspect the events. Split records on LF only, because Node `readline` is unsafe for this stream.
- `pi --mode rpc --no-session` is a long-lived JSONL command/response channel. For Node, use the exported `RpcClient` (`promptAndWait()`).
- There is no `--cwd` flag, so spawn the process with `cwd` set. For a key override, use `--api-key` or the environment variable. Do not put keys in the model prompt.

### Pi packages (e.g. pi-multix)
- Install with `pi install npm:pi-multix` (global, written to `~/.pi/agent/settings.json`) or `pi install npm:pi-multix -l` (project `.pi/settings.json`, which loads only when the project is trusted). Pin with `@0.1.6`. Try without installing with `pi -e npm:pi-multix`. A package declares `"pi": { "extensions": [...], "skills": [...] }` in `package.json`.
- pi-multix 0.1.6 (2026-09-23, bestagentkits) provides the `multix_image`, `multix_video`, `multix_audio`, `multix_media`, `multix_doc`, `multix_run`, `multix_check`, and `multix_models` tools plus a `multix` skill. It reads keys from env, then `<cwd>/.env`, then `~/.multix/.env`. It is young (0.x) and has a single maintainer.
- Adoption risk: Pi is very active (pushed today), but it moves fast. It went from 0.73 to 0.87 in about four months, and the npm scope and repo org were renamed. Pin exact versions.

## B. "Jev" (TypeSafe AI)
- **What it is.** Jev is TypeSafe AI's decision model, launched 2026-09-15 alongside a $40M seed round. Current versioned id: `jev-1.13.0`. Aliases: `jev-latest` and `jev-preview`. It uses TypeSafe's own endpoint `POST /v1/systemone` with body `{model, state, questions}`, and the SDK is npm `@typesafe-ai/sdk` 0.6.0. Pricing is **$0.042/M input tokens with free output**. Context is 64k per request (32k for state plus the longest question), input is text only, and limits are 1,200 RPM at launch and change dynamically. **There is no chat completions, `response_format`, or tool calling.** TypeSafe's docs page "Jev with coding agents" states it is not a drop-in coding-agent LLM.
- **OpenRouter.** The only `/models` entry is `typesafe/jev-router` ("TypeSafe: Jev Router"). It lists pricing as `-1` (variable, meaning you pay for whichever model it routes to; press reports a zero router fee), a 1M context, and an **empty `supported_parameters`**, so tools and structured outputs are unadvertised. The `endpoints` list is also empty. `~typesafe/jev-latest` exists as a detail page with modality `text->decisions`. The routing pool is unpublished and cannot be constrained.
- **Fit.** It could make routing decisions for Motion MCP, such as choosing the cheap or strong model per scene or scoring whether a patch is needed. It cannot author HyperFrames HTML.
- **Make the model configurable.** Use environment variables or config keys `CODER_MODEL` (Pi, default `deepseek/deepseek-v4-flash`), `PLANNER_MODEL` (structured JSON, default `anthropic/claude-opus-5.5`), and optional `ROUTER_MODEL=typesafe/jev-router`. At startup, check each id against `GET /api/v1/models` and require the parameters it needs: `tools` for the coder, `structured_outputs` for the planner. Fail fast if one is missing.

## C. MCP TypeScript SDK
- **Packages.** `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/node` are at 2.1.0. `@modelcontextprotocol/express` is at 2.0.1. All use zod ^4 (`import * as z from "zod/v4"`). `@modelcontextprotocol/sdk` 1.30.1 is the v1.x maintenance line.
- **Streamable HTTP, stateless (default and recommended).** `createMcpHandler(factory)` builds a fresh `McpServer` per request and keeps no `Mcp-Session-Id` state. It scales horizontally and serves legacy clients statelessly (`legacy: 'stateless'`, the default; set `'reject'` for modern-only). Session mode exists only on the hand-wired `NodeStreamableHTTPServerTransport({ sessionIdGenerator })`, which needs a session map. Motion MCP does not need it; long jobs should use job ids plus a polling tool instead.
```ts
import { createMcpExpressApp, requireBearerAuth, type OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const verifier: OAuthTokenVerifier = { async verifyAccessToken(token) {
  if (!safeEqual(token, process.env.MCP_TOKEN!)) throw new OAuthError(OAuthErrorCode.InvalidToken, "bad token");
  return { token, clientId: "motion-client", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
} };
const handler = createMcpHandler((ctx) => {
  const s = new McpServer({ name: "motion-mcp", version: "0.1.0" });
  s.registerTool("create_video", { description: "Start a motion video job",
      inputSchema: z.object({ brief: z.string() }), outputSchema: z.object({ jobId: z.string() }) },
    async ({ brief }) => { const jobId = await start(brief, ctx.authInfo);
      return { content: [{ type: "text", text: jobId }], structuredContent: { jobId } }; });
  return s;
});
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: ["mcp.example.com"] }); // DNS-rebinding guard
const node = toNodeHandler(handler);
app.all("/mcp", requireBearerAuth({ verifier, requiredScopes: ["mcp"] }), (req, res) => void node(req, res, req.body));
app.listen(3000);
```
- **Testing, in-process with no port.** Use `new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), { fetch: (u, i) => handler.fetch(new Request(u, i)) })`, then `new Client({...}, { versionNegotiation: { mode: "auto" } })`, `connect`, and `callTool`. Assert on `structuredContent` and `isError`. Schema rejections come back as `isError: true`, not as exceptions. Close the client first, then the handler. A curl smoke test needs `Accept: application/json, text/event-stream`.

### OpenRouter models (public /models endpoint, 2026-09-26, USD per 1M tokens in/out)
| Model id | In / Out | Context | tools | structured_outputs |
|---|---|---|---|---|
| `anthropic/claude-opus-5.5` | 4.00 / 20.00 (`:batch` 2/10) | 1M | yes | yes |
| `anthropic/claude-sonnet-5` | 2.00 / 10.00 | 1M | yes | yes |
| `deepseek/deepseek-v4-flash` | 0.047 / 0.094 | 1M | yes | yes |
| `z-ai/glm-5.3-flash` | 0.04 / 0.50 | 1.31M | yes | yes |
| `qwen/qwen3.8-flash` | 0.15 / 0.47 | 1M | yes | yes |
| `minimax/minimax-m3` | 0.30 / 1.20 | 1M | yes | yes |
| `moonshotai/kimi-k2.7-code` | 0.66 / 3.30 | 262k | yes | yes |
| `typesafe/jev-router` | variable (-1) | 1M | not listed | not listed |
- Per-token price is the table value divided by 1e6. For example, Opus 5.5 is $0.000004 per input token and $0.00002 per output token.
- For structured output, send `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }` together with `provider: { require_parameters: true }` so the request only goes to endpoints that support it. Streaming works. The Response Healing plugin applies to non-streaming json_schema requests. Generate the schema from zod with `z.toJSONSchema()`.
- Recommended ranking for the Pi coder model: (1) `deepseek/deepseek-v4-flash`, the cheapest with full tools and structured-output support; (2) `z-ai/glm-5.3-flash`; (3) `qwen/qwen3.8-flash`; with `moonshotai/kimi-k2.7-code` as a quality fallback. The ranking uses price and capability flags only, so benchmark on real HyperFrames tasks before committing.

## Limitations
- Pi code samples come from repo docs and examples at HEAD (0.87.1). They were not compiled against the installed package.
- I did not inspect the published OpenRouter catalog inside the Pi package; a local hook blocked reading the built `dist` output. Before choosing an id, confirm it is present with `pi --list-models openrouter`.
- OpenRouter prices change and some may be promotional. The Jev Router behavior with tools and `response_format` is untested because I made no paid calls.

## Unresolved questions
1. Does "Jev" in the brief mean `typesafe/jev-router` (chat routing) or the TypeSafe decision API? This changes whether it is a model option or a separate routing component.
2. What isolation boundary will Pi jobs run in (container per job or a restricted user)? `cwd` alone is not a boundary.
3. Should pi-multix be installed globally on the worker image or pinned per project (`-l` plus project trust)?
4. Is OAuth (MCP authorization with resource metadata) required later, or is a static Bearer token enough?
