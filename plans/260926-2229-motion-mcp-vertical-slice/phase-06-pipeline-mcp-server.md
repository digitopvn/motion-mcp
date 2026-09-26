# Phase 06 — Pipeline orchestrator, MCP server, CLI

## Context
Depends on phases 02–05. Read the exported APIs of every package, `plans/reports/architecture-260926-2229-synthesis.md` §4–6 (MCP contract, execution graph, data model) and `plans/reports/researcher-260926-2229-pi-jev-mcp.md` §C (MCP SDK v2).

## Files owned
`packages/pipeline/**`, `apps/mcp-server/**`.

## Requirements
### packages/pipeline
- `runCreateJob(ctx, input)` execution graph: normalize intent → resolve director mode → creative spec (host spec validated, or internal Opus) → `compileCreativeSpec` → HyperFrames compile (deterministic tier) and Pi build for `implementation: "custom"` scenes → lint → check → contact sheet → cheap visual QA → Jev classification per issue → cheap fix (IR patch + recompile, or Pi patch) or Opus critique (bounded by budget and `MAX_REVISION_LOOPS`) → preview render → final render → FFmpeg finish → store artifacts → persist project/job → trace summary and credit capture.
- `runEditJob` (instruction or `ScenePatch` → apply → rerender affected output) and `runRenderJob` (preview|final from stored IR).
- Host-opus critique: when the loop wants a creative critique in host mode, set job status `awaiting_host` and return the host critique request instead of calling Opus internally.
- In-process job queue with concurrency 1 for renders, cancellation via AbortSignal, progress persisted to the job repo.
- Budget guard: reserve credits from `quoteJob`, capture actual, release the remainder; stop with `BUDGET_EXCEEDED` if the reservation would be exceeded.

### apps/mcp-server
- Streamable HTTP MCP at `/mcp` using the MCP SDK v2 stateless handler, bearer auth (API keys from `MOTION_API_KEYS` or the ApiKey repo), host allow-list from `ALLOWED_HOSTS`, `/healthz`, and static artifact download at `/artifacts/*` with signed short-lived URLs when the store is local.
- Exactly 8 public tools with zod input/output schemas: `motion_create`, `motion_edit`, `motion_inspect`, `motion_render`, `motion_search`, `motion_get_project`, `motion_list_projects`, `motion_publish`. `motion_inspect` without a project returns the capability handshake (director modes, formats, quality presets, schemas for CreativeSpec/ScenePatch, credit prices).
- No tool exposes shell, filesystem paths outside artifacts, or provider secrets.
- `src/cli.ts`: `motion create --brief … [--spec file] [--mode] [--quality]`, `motion render`, `motion doctor`, `motion schema`.
- Tests: in-process MCP protocol tests via `handler.fetch` (initialize, `tools/list` returns exactly 8 tools, auth rejection, `motion_inspect` handshake, `motion_create` in host-opus mode with the golden fixture using the deterministic tier and a stubbed renderer).

## Validation
`pnpm check` green; local E2E: brief → preview + final MP4 in host-opus mode offline, and internal-opus mode when `OPENROUTER_API_KEY` is set.

## Implementation status (2026-09-27)
Done. The report is at `plans/reports/fullstack-developer-260926-phase-06-pipeline-mcp-server.md`.
- [x] Pipeline graph (`runCreateJob`, `runEditJob`, `runRenderJob`), host-opus `awaiting_host` round trip, in-process queue, persisted progress, interrupted-job recovery
- [x] Budget guard: `quoteJob` reservation (worst-case critiques), capture of actual use, release on failure; `INSUFFICIENT_CREDITS` / `BUDGET_EXCEEDED`; idempotent trial grant
- [x] MCP server: 8 tools over `@motion-mcp/pipeline`, signed `/artifacts/*`, `/v/:renderId` publishing with range support, `POST /webhooks/polar`
- [x] CLI: `create`, `render`, `doctor`, `schema`, `keys create`
- [x] Tests: protocol tests; E2E with a real HyperFrames render (host-opus preview + 1920x1080 final, internal-opus with a scripted gateway, host critique round trip, worker fallback); billing; signed URLs; live internal-opus test
- [x] `pnpm check` green; the live E2E passed (135 credits, $0.1156 COGS)
