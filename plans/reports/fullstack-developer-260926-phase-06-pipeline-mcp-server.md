# Phase 06 Implementation Report: pipeline orchestrator, MCP server, CLI

## Executed Phase
- Phase: phase-06-pipeline-mcp-server
- Plan: `plans/260926-2229-motion-mcp-vertical-slice/`
- Status: completed

`pnpm check` is green: lint, typecheck, and 218 unit tests in 23 files, including real HyperFrames renders. Root `pnpm build` succeeds. The live internal-opus E2E passed and produced a 1920x1080, 15 s final MP4.

## Files
### Created
- `packages/pipeline/src/`
  - `index.ts`
  - `runtime.ts`: `createRuntime(config, overrides)`.
  - `motion-service.ts`: `createMotionService`, all 8 methods, and `resolvePublishedRender`.
  - `jobs.ts`: the job lifecycle, the create, edit and render graphs, and `recoverInterruptedJobs`.
  - `build-version.ts`: compile, the worker, QA, the revision loop, storage and rendering.
  - `qa.ts`: the vision QA source and mechanical patches.
  - `billing-guard.ts`
  - `job-queue.ts`
  - `job-record.ts`
  - `artifact-urls.ts`
  - `search.ts`
- `packages/pipeline/test/pipeline-units.test.ts`
- `apps/mcp-server/src/`
  - `server.ts`: `buildApp`, the verifiers, `startServer` and `doctorSummary`.
  - `public-routes.ts`: `/artifacts/*`, `/v/:renderId` and `POST /webhooks/polar`.
  - `main.ts`
  - `cli.ts`
- `apps/mcp-server/test/`
  - `harness.ts`
  - `pipeline-e2e.test.ts`
  - `pipeline.live.test.ts`

### Moved
`tool-schemas.ts` and `motion-service.ts` moved from `apps/mcp-server/src/` to `packages/pipeline/src/contract/` without changes. The app imports them from `@motion-mcp/pipeline`.

### Modified
- `apps/mcp-server/src/http-app.ts`: the Express app is now built by hand.
  - `hostHeaderValidation` is applied first, then public routes are mounted before any body parser, so the webhook sees the raw body.
  - `express.json` runs on `/mcp` only.
- `apps/mcp-server/src/mcp-handler.ts` and `test/mcp-protocol.test.ts`: import paths only.
- `apps/mcp-server/package.json`:
  - tsdown and the build script were removed.
  - `start` is now `node --import tsx src/main.ts`.
  - `tsx` 4.23.15 is a regular dependency.
  - The workspace packages it uses were added, plus jev-router, llm and pi-runtime as dev dependencies.
- `packages/pipeline/package.json`: the 13 workspace packages and `zod` 4.6.5 were added as dependencies.
- `packages/shared/src/config.ts`: three keys were added:
  - `JOB_CONCURRENCY` (default 1)
  - `TRIAL_CREDITS` (default 500)
  - `ARTIFACT_SIGNING_SECRET` (optional)
- The phase file and the `plan.md` status row were updated.

## Design decisions to review
1. **Pipeline state lives in `Job.result`.** This covers renders, issues, frame keys, the critique request, usage and the reservation, and it is validated by zod. The project schema strips unknown keys.
2. **Per-version storage.** Each version's IR and scene overrides are stored in the artifact store under `compositions/v<n>/`. Worker-built HTML is pinned to the exact scene JSON it implements, so an IR change to that scene invalidates it.
3. **Credit reservations cover the worst case.** Internal modes reserve for `min(perJob critique cap, MAX_REVISION_LOOPS)` critiques. Capture bills only actual use.
   - Why: reserving a single critique made the final render's budget gate fail after two critiques.
4. **What blocks a final render.** Only deterministic errors block it: lint, check, timeline and render. Vision and critique errors are still reported on the version, but they never veto a final render the caller asked for.
   - Why: the first live run skipped the final render because of a flash-lite `low_contrast` "error".
5. **Worker safety net.** Before classification, worker-built scenes with lint or check errors fall back to the deterministic compiler.
   - Why: the second live run had Pi-built scenes referencing a missing font. That passed lint, and `check` showed it as `runtime_error`, which was then escalated as a creative issue.
   - How: after a first targeted pass, all remaining worker scenes are reverted. The check does not attribute every repeated finding.
   - A test covers this with a fake worker.
6. **Warnings appear in the job message.** They show in `job.message` on `motion_get_project`, redacted and with local paths replaced by `<path>`. Examples are a skipped final render and reverted worker scenes. Without this a client could not tell why a final was missing.
7. **Publishing.** `motion_publish` writes `public/<renderId>.json`.
   - `/v/<renderId>` streams from the local store with range support and a video/mp4 content type, and redirects to a presigned URL for R2.
   - Only succeeded final renders can be published.
8. **Starting a render.**
   - A `final` `motion_render` is rejected with `invalid_input` while the version has lint or check errors.
   - `directorMode: "custom"` is rejected up front, because no workspace planner model exists yet.
9. **Anonymous access.** It is allowed only when `NODE_ENV=development` and no static keys are set. The public hostname from `PUBLIC_BASE_URL` is always added to the host allow-list.

## Tests
- **Pipeline unit tests (9):**
  - Signer: valid, tampered key, tampered expiry, tampered signature, other secret, expired, and unsafe keys.
  - Signing-secret derivation.
  - Idempotent trial grant, including concurrent calls and separate instances.
  - INSUFFICIENT_CREDITS and BUDGET_EXCEEDED mapping.
  - Queue order, duplicate jobs, and abort on close.
  - BM25 ranking and exact matches.
- **E2E through the real MCP HTTP handler with real renders (4):**
  - Host-opus: zero model calls; the preview is probed at 16:9 and about 6 s, and the final at 1920x1080. It also covers the capabilities handshake, the usage breakdown, ledger balance and `held == 0`, the publish URL with a `Range` request returning 206 and video/mp4, and `motion_search` with `exact: true`.
  - Internal-opus with `ScriptedGateway`: exactly one gateway call, `creative_direction` billed, and credits captured.
  - Host critique round trip with an injected QA source:
    - The job reaches `awaiting_host` with a `crq_` request whose frames are signed URLs.
    - An unknown request id returns `not_found`.
    - `motion_edit` with the patches creates version 2, and the patch is visible in `motion_inspect`.
    - A stale `baseVersion` returns `conflict`.
  - Worker fallback: a broken worker leads to a final render with no deterministic errors.
- **Service tests without rendering (4):** `insufficient_credits` with TRIAL_CREDITS=0, `budget_exceeded`, fast-fail guidance for host-opus without a spec and internal-opus without a gateway, the styles index, and the webhook returning 404 when it is not configured.
- **Protocol tests:** the existing 5 still pass.
- **Test isolation:** the tests use temp `DATA_DIR`s, a rules-only decision chain, `gateway: null` and `sceneWorker: null`, so they make no network or model calls. The render tests skip only when doctor reports HyperFrames, Chrome or FFmpeg missing.

## Live run
Command: `pnpm exec vitest run --project live --silent=false apps/mcp-server/test/pipeline.live.test.ts`. It uses internal-opus, 15 s, final quality, and the `.env` key.

The passing run:
- **Credits:** 135 = orchestration 20 + creative_direction 100 + preview 8 + render_minute_hd 7.
- **COGS:** $0.1156. Opus was $0.0650, vision was $0.0006, and render COGS was $0.05.
- **Calls and time:** 2 model calls, 1 of them Opus, in 166 s.
- **Output:** a 1920x1080, 15 s MP4.

Two earlier paid runs of about $0.11 each surfaced findings 4 and 5 above; both are now fixed. A CLI smoke run of host-opus with vision QA cost $0.0305. Total spend for this phase was about $0.47.

## Smoke checks
- **CLI:** `pnpm motion schema`, `doctor`, `keys create --name smoke` (in a scratch DATA_DIR) and `create --spec … --duration 6 --out` all work.
- **Server:** `main.ts` booted on port 8799.
  - Responses: `/healthz` 200, `/mcp` without auth 401, a bad Host header 403, an unsigned artifact 403, and the webhook 404 when not configured.
  - The doctor summary was logged. The server was then stopped, and no process remains on the port.

## Concerns (outside my file ownership, not edited)
- **`.env.example` and the docs** (MCP_API or ARCHITECTURE config tables) should list `JOB_CONCURRENCY`, `TRIAL_CREDITS` and `ARTIFACT_SIGNING_SECRET`. The docs should also cover:
  - the `/artifacts`, `/v/:renderId` and `/webhooks/polar` routes;
  - `pnpm motion keys create`;
  - job warnings appearing in `job.message`.
- **`@motion-mcp/pi-runtime` quality:** in the live run the Pi worker produced HTML that referenced `/assets/fonts/newsreader-latin-400-normal.woff2`, a file that does not exist. The pipeline now falls back safely. A real fix would give the worker the compiled `@font-face` rules, or forbid new font URLs in its skill prompt.
- **`@motion-mcp/jev-router` rules:** a `check` `runtime_error` was classified as `needsOpus`, which led to a creative critique. Runtime errors are mechanical and should not escalate. The pipeline now handles worker-caused cases before classification.
- **Noisy stderr during renders:** `@motion-mcp/hyperframes-adapter` logs `[INFO] [Compiler] Embedded local font …` to stderr on every compile. Cosmetic only.
- **Test runtime:** vitest suppresses `console.log` for passing tests, so the live test needs `--silent=false` to show its cost line. `pnpm check` now takes about 4–5 minutes because of the real renders.

## Unresolved questions
- Should vision "error" findings ever block a final render, for example once a stronger vision model is configured? The current rule, that deterministic findings only block, is a product decision worth confirming.
- Trial credits default to 500 per new workspace, including the static-key `ws_default`. Confirm this is intended for production.

Status: DONE_WITH_CONCERNS
Summary: The pipeline package (runtime, job graph, queue, billing, signed artifacts, search, publishing) and the MCP server (8 tools, public routes, main.ts, CLI) are implemented. `pnpm check` is green with real-render E2E tests, and the live internal-opus run produced a 1920x1080 final at 135 credits and $0.1156 COGS.
Concerns/Blockers: Docs and `.env.example` need the new keys and routes, which are outside my files. Pi worker font references and Jev's runtime_error escalation should be fixed in their own packages; the pipeline now guards against both.
