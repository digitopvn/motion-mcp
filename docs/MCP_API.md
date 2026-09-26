# MCP API v0.1

Motion MCP exposes exactly eight public tools over stateless Streamable HTTP at
`/mcp` ([ADR 0008](decisions/0008-stateless-streamable-http-mcp.md)), plus a few
plain HTTP routes and a local `motion` CLI. The authorities are:

- tool input and output schemas: `packages/pipeline/src/contract/tool-schemas.ts`,
  served by `tools/list`;
- tool registration and error mapping: `apps/mcp-server/src/mcp-handler.ts`;
- tool behavior: `packages/pipeline/src/motion-service.ts`;
- HTTP routes: `apps/mcp-server/src/http-app.ts` and `public-routes.ts`;
- CLI: `apps/mcp-server/src/cli.ts` (`pnpm motion help`).

This document records the rules a client needs and the reasons for them.

## Transport and auth

- **Transport.** The server uses `@modelcontextprotocol/server` with
  `createMcpHandler`, which is stateless: it issues no `Mcp-Session-Id` and
  builds a fresh MCP server per request. Clients must send
  `Accept: application/json, text/event-stream`.
- **Auth.** `/mcp` requires `Authorization: Bearer <api key>`. A missing or
  unknown key gets HTTP 401 with a `WWW-Authenticate` header before any tool
  runs. Two kinds of key are accepted:
  - workspace keys created with `pnpm motion keys create`, stored only as a
    hash and a display prefix;
  - static keys from `MOTION_API_KEYS`, which map to the default workspace.

  With `NODE_ENV=development` and no static keys, unauthenticated calls are
  accepted as the default workspace, and the server logs a warning. Details are
  in [SECURITY.md](SECURITY.md#mcp-authentication).
- **Host allow-list.** Every route checks the `Host` header against
  `ALLOWED_HOSTS` plus the host of `PUBLIC_BASE_URL`, and rejects anything else
  with 403. This protects against DNS rebinding.

## HTTP routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | None | Liveness and server version. Used by the Docker health checks and the deploy workflow. |
| `/mcp` | Bearer key | The MCP endpoint. |
| `GET /artifacts/<key>?exp=…&sig=…` | HMAC-signed URL | Serves local-storage artifacts (renders, contact sheets, frames) with range support. URLs expire (one hour by default); a bad or expired signature gets 403. With R2 storage, clients get presigned R2 URLs instead. |
| `GET /v/<renderId>` | None | A render published with `motion_publish`, streamed with range support, or redirected to a presigned URL on R2. Unlisted renders carry `X-Robots-Tag: noindex`. |
| `POST /webhooks/polar` | Standard Webhooks signature | Polar events (see [BILLING.md](BILLING.md#polar-webhooks)). Returns 404 when `POLAR_WEBHOOK_SECRET` is unset. |

Artifacts are served with `nosniff` and a sandboxing Content Security Policy,
and compositions are served as plain text, because they are HTML generated from
model output.

## Jobs and polling

Long work never blocks a tool call. `motion_create`, `motion_edit` and
`motion_render` reserve credits, enqueue a job and return a `jobId` with a
`next` hint. Clients poll `motion_get_project` until the job state is
`succeeded`, `failed` or `awaiting_host`.

| State | Meaning |
|---|---|
| `queued`, `running` | In progress. `job.stage` names the current graph node and `job.progress` is 0..1. |
| `awaiting_host` | Paused for a host critique request (see [DIRECTOR_PROTOCOL.md](DIRECTOR_PROTOCOL.md#host-mode-critique-requests)). |
| `succeeded` | Done. `job.message` lists warnings, such as a skipped final render or reverted worker scenes. |
| `failed`, `cancelled` | Stopped, and held credits are released. `job.error.code` is the lower-cased internal error code (for example `provider` or `timeout`), `internal` for unexpected failures, or `interrupted` when the server restarted mid-job. |

Only one job runs per project at a time; starting another returns `conflict`.

## Public tools

| Tool | Purpose and rules |
|---|---|
| `motion_create` | Start a video from a `brief`. Passing a `creativeSpec` without `directorMode` selects `host-opus`. `host-opus` without a spec, or a spec with another explicit mode, is `invalid_input`. `custom` is rejected until workspace planner models exist. `internal-opus` needs `OPENROUTER_API_KEY` on the server. `quality` defaults to `preview`; `final` also renders a final when the render gate passes. `recipeId` is accepted but not yet used. |
| `motion_edit` | Revise a project with `instruction` and/or `scenePatches`, or answer a critique request with `critiqueRequestId` plus `scenePatches` for that scene only. In `host-opus` mode free text is refused: the host authors `scenePatches` itself. A stale `baseVersion` is `conflict`. A successful edit produces the next version. |
| `motion_inspect` | `capabilities` (the default) is the director handshake: server and IR versions, director modes, the `CreativeSpec` and `ScenePatch` JSON Schemas, prompt guidance, formats, quality presets, pricing and limits. `project` and `scene` return the Motion IR, QA issues and signed frame or contact-sheet URLs for a version. `styles` lists the domain-pack styles. |
| `motion_render` | Render a stored version at `preview` or `final` quality (`mp4` only). A final is refused with `invalid_input` while that version has lint or check errors. Returns a `renderId` and `estimatedCredits`. |
| `motion_search` | Search the workspace's projects and scenes and the domain pack's styles and patterns. See [SEARCH.md](SEARCH.md). |
| `motion_get_project` | Project state, the latest job, a pending `critiqueRequest`, and renders with signed download URLs. `include` adds `versions`, `usage`, a redacted `trace` summary or the `ir`. |
| `motion_list_projects` | The workspace's projects, with cursor pagination. |
| `motion_publish` | Publish a succeeded final render as `unlisted` (the default) or `public`, at `${PUBLIC_BASE_URL}/v/<renderId>`. |

## Errors

Tool failures return `isError: true` with
`structuredContent: { error: { code, message, details? } }`. Schema rejections
by the SDK also arrive as `isError` results, not as protocol exceptions.
Internal failures return a generic message and no details, so nothing internal
leaks; the full error is in the server log and the job trace.

| Code | Meaning |
|---|---|
| `invalid_input` | The arguments failed validation, a mode rule was broken, or a final render was requested for a version with lint or check errors. `details` may list the issues. |
| `not_found` | The project, version, scene, render or critique request does not exist in this workspace. |
| `unauthorized` | The caller lacks access to the resource. A missing or bad key gets HTTP 401 instead. |
| `conflict` | `baseVersion` is stale, a job is already running for the project, or the project has no version yet. |
| `insufficient_credits` | The balance cannot cover the job's quoted credits. |
| `budget_exceeded` | The job's quote is above the caller's `budgetCredits`. |
| `rate_limited` | The server is shutting down and not accepting jobs. Per-key rate limits are **planned**. |
| `provider_unavailable` | A model or media provider failed or timed out after retries. |
| `internal` | Anything else, including render and configuration failures. |

## CLI

`pnpm motion <command>` runs the same pipeline in-process against the local
`DATA_DIR`, without HTTP or auth. Run `pnpm motion help` for the options.

| Command | Purpose |
|---|---|
| `create` | Run a create job to completion from `--brief` or a `--spec` file, then print outputs, the trace tree and cost. |
| `render` | Render a stored project version to completion. |
| `doctor` | Check Node, HyperFrames, Chrome, FFmpeg and which providers are configured, without printing secrets. |
| `schema` | Print the `CreativeSpec` and `ScenePatch` JSON Schemas. |
| `keys create` | Create a workspace API key. The key is printed once and only its hash is stored. |

## Internal worker tools

Pi workers get only file tools and a `submit_scene` tool, never the public
tools. The richer internal tool set in the original design (`motion_read_spec`,
`motion_scene_build`, `motion_asset_generate`, `motion_ffmpeg` and the rest) is
**planned**. See [AGENT_RUNTIME.md](AGENT_RUNTIME.md#tool-allow-list).

## Versioning

- Tool names are stable. Within v0, changes are additive only: new optional
  input fields and new output fields.
- A breaking change to a tool's contract bumps the server's major version,
  which `motion_inspect` capabilities reports as `serverVersion`.
- The Motion IR version is independent of the server version. See
  [MOTION_IR.md](MOTION_IR.md#versioning).
