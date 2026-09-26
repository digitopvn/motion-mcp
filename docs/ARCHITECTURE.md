# Architecture

This document describes the v0.1 design, and none of it has been implemented
yet. As each package is built, its source takes over as the authority for
behavior. For the database, that means the drizzle schema in
`packages/database`; for the object layout, `packages/storage`. This document
keeps the boundaries and the reasons behind them.

## Component diagram

```
MCP client ──► apps/mcp-server  (Streamable HTTP, bearer auth, 8 public tools)
                   │ validate, authorize, enqueue job, answer polls
                   ▼
            packages/pipeline  (execution graph, job store, budgets, traces)
     ┌──────────┬───────────┬────────────┬────────────────┬──────────────┐
  director   jev-router   pi-runtime   hyperframes-adapter   media
  (Opus via  (typed       (Pi SDK,     (compile IR→HTML,     (multix runner,
  OpenRouter  decisions)   cheap coder  lint, check,          FFmpeg, price
  or host)                 model)       snapshot, render)     table, registry)
     └── motion-ir · domain-pack · observability · billing · storage · database · shared
```

## Packages and boundaries

The one rule behind these boundaries is that each external dependency has
exactly one owning package. When upstream churns, only one wrapper changes.

| Package | Responsibility | Boundary |
|---|---|---|
| `apps/mcp-server` | Serves MCP orchestration: transport, auth, the host allow-list, input validation, job creation and polling responses. | Contains no pipeline logic. It calls `pipeline` and reads repositories. |
| `apps/marketing` | Static marketing site. | Imports no engine code. |
| `apps/dashboard`, `apps/render-worker` | The editor UI and a dedicated render process. Both are later additions. | `render-worker` consumes the same pipeline jobs. |
| `packages/pipeline` | Runs the execution graph: job state, retries, the revision-loop bound, budget checks and the root trace span. | This is the only scheduler. Pi is a worker, never the job scheduler. |
| `packages/motion-ir` | Holds the zod schemas for Motion IR, `TastePacket`, `CreativeSpec` and `ScenePatch`, plus JSON Schema export and migrations. | Stays renderer-neutral and imports nothing from renderers. |
| `packages/director` | Holds Opus prompts, the stage contracts, critique bundles and host critique requests. | Calls models only through the OpenRouter client. |
| `packages/jev-router` | Holds `DecisionClient` and its TypeSafe, OpenRouter and rules adapters. | Returns typed answers and never generates content. |
| `packages/pi-runtime` | Wraps the Pi SDK: sessions, tool allow-list, submit tool, path guard and skills. | This is the only package that imports `@earendil-works/*`. |
| `packages/hyperframes-adapter` | Holds the deterministic IR→HTML compiler, in-process lint, the CLI `check` and `snapshot` calls, and producer renders. | This is the only package that imports `@hyperframes/*` or spawns `hyperframes`. |
| `packages/media` | Holds the multix runner, capability matrix, price table and FFmpeg transforms. | This is the only package that spawns `multix`, `ffmpeg` or `magick`. |
| `packages/domain-pack` | Holds style profiles, the resolver and tag-based retrieval. | Read-only knowledge that is versioned with the repo. |
| `packages/observability` | Holds the span model, cost fields and exporters. | Every package writes spans through it. |
| `packages/billing` | Holds the credit ledger, price table and Polar webhooks. | Balances are never mutated outside the ledger. |
| `packages/storage` | Holds the artifact drivers (local disk and R2 over the S3 API). | Large binaries go here and never into the database. |
| `packages/database` | Holds the repository interfaces, the file-backed store and the PostgreSQL implementation (drizzle). | The engine depends on the interfaces only. |
| `packages/shared` | Holds config loading, errors, ids and redaction. | Has no dependencies on the other packages. |
| `packages/{search,taste-memory,recipes,auth}` | Added in the phases that need them. | See [ROADMAP.md](ROADMAP.md). |

Each kind of model has a fixed role:

- **Worker model.** The cheap coder model (`CODER_MODEL`) runs only inside
  `pi-runtime`.
- **Director model.** The director model runs only inside `director`.
- **Decision model.** The decision model runs only inside `jev-router`.

## Execution graph

```
video.generate
├─ intent.normalize            deterministic
├─ jev.route (director?)       rules/Jev: valid host spec → skip Opus
├─ director.opus | director.host   Stage 1+2 → CreativeSpec
├─ motion_ir.compile           deterministic CreativeSpec → MotionIR (+ domain-pack defaults)
├─ scenes.build (per scene)    deterministic compiler, or Pi worker when scene.needsCustomCode
├─ hyperframes.lint → hyperframes.check → snapshot.contact_sheet
├─ vision.qa                   normalize issues into a fixed taxonomy
├─ jev.classify (per issue)    mechanical → Pi patch · asset → media · render → retry ·
│                              creative → Opus critique, or host critique request
├─ revision                    bounded loops, budget-checked
├─ preview.render (draft) → final.render (standard/high)
└─ ffmpeg.finish               faststart, yuv420p, loudnorm when audio is present
```

Vision QA sorts every issue into a fixed taxonomy: clipping, overflow,
contrast, empty frame, timing mismatch, safe area and collisions. The routing
rules are in [JEV_ROUTING.md](JEV_ROUTING.md) and the director stages are in
[DIRECTOR_PROTOCOL.md](DIRECTOR_PROTOCOL.md).

## Data model

PostgreSQL is the system of record in production. The slice runs the same
repository interfaces on a file-backed store
([ADR 0009](decisions/0009-persistence-repositories.md)).

The split follows two rules:

- **Normalized columns** hold what is queried, joined, constrained or summed.
- **JSONB** holds versioned documents that are always read whole.

| Entity | Normalized fields | JSONB |
|---|---|---|
| `users` | id, email, created_at | — |
| `workspaces` | id, owner_id, default_director_mode, plan, created_at | settings |
| `api_keys` | id, workspace_id, key_hash, prefix, last_used_at, revoked_at | scopes |
| `projects` | id, workspace_id, title, status, current_version_id, created_at, updated_at | — |
| `videos` | id, project_id, format (width, height, fps), duration_s | — |
| `scenes` | id, video_id, scene_key, index, role, duration_s, build_tier (compiler or pi) | — |
| `versions` | id, project_id, number, parent_version_id, source (create, edit, patch), created_at | — |
| `motion_ir_versions` | id, version_id, ir_version | document (the Motion IR) |
| `taste_packets` | id, project_id, version_id, director_mode | document |
| `taste_preferences` | id, workspace_id, kind (accepted, rejected, edited), scene_role, created_at | signal |
| `recipes` | id, workspace_id (null means built-in), slug, title | template |
| `assets` | id, workspace_id, kind, storage_key, mime, bytes, provider, sha256 | metadata |
| `renders` | id, version_id, quality, format, status, storage_key, duration_s, render_seconds | settings |
| `generation_jobs` | id, project_id, kind, state, stage, attempts, budget_credits, reserved_credits, started_at, finished_at | graph_state, error |
| `model_calls` | id, job_id, span_id, role, provider, model, tokens_in, tokens_out, cache_read_tokens, cost_usd_micros | — |
| `traces` / `spans` | trace_id, span_id, parent_span_id, job_id, name, status, started_at, duration_ms, cogs_usd_micros | attributes |
| `usage_events` | id, workspace_id, job_id, operation, quantity, unit, credits | — |
| `credit_ledger` | id, transaction_id, account, workspace_id, amount_credits, idempotency_key, created_at | memo |
| `provider_credentials` | id, workspace_id, provider, ciphertext, key_version, last4, created_at | — |
| `search_documents` | id, workspace_id (null means global), doc_type, ref_id, tsv (tsvector), embedding (pgvector) | payload |

Money is stored as integer credits in the ledger and as integer USD micros in
costs. Credits are defined in [BILLING.md](BILLING.md). Large binaries never go
into the database; they live in object storage and rows point to them with
`storage_key`.

## Storage layout (planned)

Object keys are scoped per workspace and per project, and `packages/storage`
owns the exact scheme. The same keys work on the local-disk driver, which writes
under the git-ignored `.data/` directory, and on the R2 driver.

```
{workspaceId}/projects/{projectId}/versions/{n}/composition/   HyperFrames project (index.html, compositions/, assets/)
{workspaceId}/projects/{projectId}/versions/{n}/snapshots/     contact sheets and frames
{workspaceId}/projects/{projectId}/renders/{renderId}.mp4      preview and final renders
{workspaceId}/assets/{sha256}.{ext}                            generated or uploaded media, deduplicated by hash
```

Pi workers and HyperFrames operate on a per-job working directory, and the
pipeline syncs results back to storage. Locally that directory is under the
git-ignored `workspaces/` directory.

## Deployment topology (planned)

Details are in [ADR 0011](decisions/0011-docker-cloudflare-deployment.md).

```
Internet ──► Cloudflare ──► Cloudflare Tunnel (cloudflared container)
                               │  app.motion.digitop.ai/mcp
                               ▼
                 VPS: docker compose
                 ├─ mcp-server + pipeline   (Node 22, Chrome headless shell, FFmpeg, ImageMagick)
                 ├─ postgres (+ pgvector)
                 └─ cloudflared
                         │
                         └──► Cloudflare R2 (artifacts, via S3 API)

motion.digitop.ai ──► Cloudflare Workers static assets (apps/marketing)
```

Production renders run only in the Linux image. Windows capture is
screenshot-based and not deterministic, so Windows is used for development
only.
