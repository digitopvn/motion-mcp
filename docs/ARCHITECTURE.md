# Architecture

This document keeps the package boundaries, the shape of the execution graph
and the reasons behind them. The source of each package is the authority for
its behavior; the sections below point to it.

## Component diagram

```
MCP client ──► apps/mcp-server  (Express: host allow-list, bearer auth, /mcp, public routes)
                   │ validate, authorize, enqueue job, answer polls
                   ▼
            packages/pipeline  (runtime, job queue, execution graph, budgets, traces, search)
     ┌──────────┬───────────┬────────────┬────────────────┬──────────────┐
  director   jev-router   pi-runtime   hyperframes-adapter   media
  (director  (typed       (Pi SDK,     (compile IR→HTML,     (FFmpeg finishing,
  model via   decisions)   cheap coder  lint, check,          multix runner,
  OpenRouter               model)       snapshot, render)     price table)
  or host)
     └── motion-ir · domain-pack · llm · observability · billing · storage · database · shared
```

## Packages and boundaries

The one rule behind these boundaries is that each external dependency has
exactly one owning package. When upstream churns, only one wrapper changes.

| Package | Responsibility | Boundary |
|---|---|---|
| `apps/mcp-server` | HTTP transport, host allow-list, bearer auth, the eight MCP tools, public routes (`/healthz`, `/artifacts/*`, `/v/:renderId`, `/webhooks/polar`) and the `motion` CLI. | Contains no pipeline logic. It calls the `pipeline` service. See [MCP_API.md](MCP_API.md). |
| `apps/marketing` | Static marketing site on Cloudflare Workers static assets. | Imports no engine code. |
| `apps/dashboard` | React SPA built with Vite and served by `apps/mcp-server` at `/`; it talks to the cookie-session JSON API under `/api` ([dashboard-api.ts](../apps/mcp-server/src/dashboard-api.ts), [dashboard-auth.ts](../apps/mcp-server/src/dashboard-auth.ts)). | GitHub OAuth callback is registered on `motion.digitop.ai`; the marketing Worker ([worker.ts](../apps/marketing/src/worker.ts)) forwards `/api/auth/*` to the app. |
| `apps/render-worker` | **Planned.** A dedicated render process. | It would consume the same pipeline jobs. |
| `packages/pipeline` | The runtime (`createRuntime`), the in-process job queue, the create, edit and render graphs, the revision-loop bound, credit reservation, signed artifact URLs, publishing and search. It also owns the public tool schemas in `src/contract/`. | This is the only scheduler. Pi is a worker, never the job scheduler. |
| `packages/motion-ir` | Zod schemas for Motion IR, `TastePacket`, `CreativeSpec`, `ScenePatch` and `QaIssue`, the spec compiler, the patch applier and JSON Schema export. | Stays renderer-neutral and imports nothing from renderers. |
| `packages/director` | Director mode resolution, director prompts, spec creation, scene critique, critique bundles and host critique requests. | Calls models only through `llm`. |
| `packages/jev-router` | `DecisionClient`, its TypeSafe, LLM and rules adapters, and the routing policies. | Returns typed answers and never generates content. |
| `packages/llm` | The OpenRouter client, structured output with repair, the model price list and a scripted gateway for tests. | Owns the OpenRouter HTTP client. Pi reaches OpenRouter through the Pi SDK inside `pi-runtime`. |
| `packages/pi-runtime` | Wraps the Pi SDK: sessions, tool allow-list, submit tool, path guard, prompt building and trace mapping. | The only package that imports `@earendil-works/*`. |
| `packages/hyperframes-adapter` | The deterministic IR→HTML compiler, in-process lint, the CLI `check` and `snapshot` calls, contact sheets, renders and `doctor`. | The only package that imports `@hyperframes/*` or spawns `hyperframes`. |
| `packages/media` | FFmpeg transforms and probing, the multix runner, the capability matrix, the provider registry and the media price table. | The only package that spawns `multix` or `ffmpeg`. |
| `packages/domain-pack` | Vendored style profiles, authored knowledge files, tag retrieval and the style index. | Read-only knowledge that is versioned with the repo ([ADR 0012](decisions/0012-domain-pack-lift-and-wrap.md)). |
| `packages/observability` | The span model, cost fields and trace summaries. | Every package writes spans through it. |
| `packages/billing` | The credit price table, job quotes, the double-entry ledger and Polar webhook handling. | Balances are never mutated outside the ledger. |
| `packages/storage` | The artifact drivers: local disk and R2 over the S3 API. | Large binaries go here and never into the database. |
| `packages/database` | The repository interfaces, the file-backed store, API key helpers and the drizzle PostgreSQL schema. | The engine depends on the interfaces only. |
| `packages/shared` | Config loading, errors, ids, logging, redaction and process spawning. | Has no dependencies on the other packages. |
| `packages/{search,taste-memory,recipes,auth}` | **Planned**, added in the phases that need them. | See [ROADMAP.md](ROADMAP.md). |

Each kind of model has a fixed role, and each model id is configuration, not
code:

- **Worker model.** `CODER_MODEL` runs only inside `pi-runtime`.
- **Director model.** `DIRECTOR_MODEL` runs only inside `director`.
- **Decision model.** `DECISION_MODEL` (or TypeSafe's `JEV_MODEL`) runs only
  inside `jev-router`.
- **Vision model.** `VISION_MODEL` runs only as a QA source in `pipeline`.

## Execution graph

Every job runs inside one trace whose root span is `video.create`,
`video.edit` or `video.render`. The shared tail of create and edit is:

```
director (host spec validation, or one director call)  create only
motion_ir compile                     deterministic CreativeSpec → MotionIR
scenes.build                          deterministic compiler; Pi for scenes the implementation mode assigns
revision loop (≤ MAX_REVISION_LOOPS)
├─ inspect: hyperframes.lint → hyperframes.check → snapshot.contact_sheet → vision QA (when configured)
├─ worker safety net: worker-built scenes that fail lint/check revert to compiler output
├─ jev.route per issue: mechanical → IR patch or Pi patch · asset/render → reported
│                        creative → director critique, or pause for a host critique request
└─ recompile and re-inspect
artifacts.store                       version IR, overrides, contact sheet, frames
preview render                        always, at draft quality
final render                          only when requested and the render gate passes
```

- The graph is in `packages/pipeline/src/jobs.ts`, and the loop and build steps
  are in `packages/pipeline/src/build-version.ts`.
- `IMPLEMENTATION_MODE` picks the scene builder: `deterministic` never uses Pi,
  `auto` uses Pi for scenes marked `implementation: "custom"`, and `pi` uses it
  for every scene. See [AGENT_RUNTIME.md](AGENT_RUNTIME.md).
- A final render is blocked only by deterministic error findings (lint, check,
  timeline, render). Vision and critique findings are reported on the version
  but never veto a final the caller asked for. When the final is skipped, the
  reason appears in `job.message`.
- The issue taxonomy is `QaCategory` in `packages/motion-ir/src/patch-and-qa.ts`.
  The routing rules are in [JEV_ROUTING.md](JEV_ROUTING.md), and the director
  stages are in [DIRECTOR_PROTOCOL.md](DIRECTOR_PROTOCOL.md).
- Jobs run in-process through a queue bounded by `JOB_CONCURRENCY`. Jobs left
  `queued` or `running` by a previous process are marked failed with the
  `interrupted` code at startup, and their credits are released.

## Persistence

The runtime uses the repository interfaces from `packages/database`
([ADR 0009](decisions/0009-persistence-repositories.md)). Today every
deployment runs the file-backed implementations:

- **Records.** `FileRepository` stores projects, jobs, API keys, traces and
  usage events as JSON files under `DATA_DIR`. Pipeline state for a job lives in
  its validated `Job.result`.
- **Ledger.** The credit ledger is an append-only JSONL file under `DATA_DIR`
  (see [BILLING.md](BILLING.md)).
- **Artifacts.** `STORAGE_DRIVER` selects local disk under `DATA_DIR` or R2.
  The key scheme is `artifactKey` in `packages/storage/src/artifact-store.ts`.
  Per-version working directories live under `DATA_DIR/work`.

Both file stores lock per process only, so a data directory must have a single
writer. Running more than one app process needs the PostgreSQL repositories.

### Data model

**Planned:** PostgreSQL as the system of record. The full model is already
defined as a drizzle schema in `packages/database/src/schema.ts` (with
`drizzle.config.ts` at the package root), but nothing reads `DATABASE_URL` yet.
The schema follows two rules:

- **Normalized columns** hold what is queried, joined, constrained or summed.
- **JSONB** holds versioned documents that are always read whole.

Money is stored as integer credits in the ledger. Large binaries never go into
the database; rows point to object storage by key.

## Configuration

`ConfigSchema` in `packages/shared/src/config.ts` is the configuration
reference, with defaults, and `.env.example` is the annotated template. The
server reads `.env` from the working directory; process environment wins.
Operationally important keys that are easy to miss:

| Key | Default | Why it exists |
|---|---|---|
| `JOB_CONCURRENCY` | 1 | Jobs compile and render in-process, and renders are CPU bound, so one job runs at a time unless the host has headroom. |
| `TRIAL_CREDITS` | 500 | Early-access credits granted once per workspace the first time it is seen. 0 disables them. See [BILLING.md](BILLING.md). |
| `ARTIFACT_SIGNING_SECRET` | unset | HMAC secret for `/artifacts/*` URLs. When unset it is derived from `MOTION_API_KEYS`; without either, development uses a fixed value and production a per-process secret, so URLs stop working after a restart. Set it in production. |
| `CREDENTIALS_ENCRYPTION_KEY` | unset | 32-byte key (hex or base64) that seals workspace pi sign-ins and multix keys. Unset disables Dashboard > Model providers and every job uses the server worker. See [SECURITY.md](SECURITY.md#provider-credentials-byok). |
| `ASSET_IMAGES_PER_JOB` | 4 | Most scene images one create or edit job may generate through multix (0 to 12). Images use the workspace's multix keys first, else the server's; 0 turns generation off and image needs render as placeholders. See [BILLING.md](BILLING.md#byok). |
| `POLAR_ENVIRONMENT` | `sandbox` | Selects Polar's sandbox or production API. Declared for checkout creation, which is **planned**; the webhook handler does not use it. |
| `MAX_REVISION_LOOPS` | 2 | Upper bound on QA and fix loops per job. See [JEV_ROUTING.md](JEV_ROUTING.md). |

## Deployment topology

The decision is [ADR 0011](decisions/0011-docker-cloudflare-deployment.md). The
executable owners are [`Dockerfile`](../Dockerfile),
[`docker-compose.yml`](../docker-compose.yml),
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml),
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) and
[`apps/marketing/wrangler.jsonc`](../apps/marketing/wrangler.jsonc).

```
Internet ──► Cloudflare ──► Cloudflare Tunnel ──► cloudflared container (compose profile "tunnel")
                              app.motion.digitop.ai        │
                                                           ▼
                          VPS: docker compose
                          └─ app  (ghcr.io/digitopvn/motion-mcp image; Node 22, chrome-headless-shell, FFmpeg)
                               listens on 127.0.0.1:8787 on the host, /data volume for DATA_DIR
                                      │
                                      └──► Cloudflare R2 (when STORAGE_DRIVER=r2)

motion.digitop.ai ──► Cloudflare Workers static assets (apps/marketing)
```

- **CI** (`ci.yml`) runs lint, typecheck and the unit test project on every
  push and pull request, with FFmpeg and headless Chrome installed so real
  renders are tested. It never calls paid models.
- **Deploy** (`deploy.yml`) runs on pushes to `main`. It builds and pushes the
  image to GHCR, copies the compose file to the VPS over SSH, pulls and restarts
  the stack with the tunnel profile, then checks `/healthz` through the public
  host. A separate job deploys the marketing site with Wrangler. Secrets come
  from GitHub Actions secrets and the VPS `.env`.
- **Deploy staging** (`deploy-staging.yml`) runs on pushes to `dev`. See
  [Staging](#staging).
- **Health.** Both the image and the compose service probe `/healthz`.
- Production renders run only in the Linux image. Windows capture is
  screenshot-based and not deterministic, so Windows is for development only.

### Staging

`staging.motion.digitop.ai` runs the `dev` branch with the same image recipe
and compose file as production, isolated on every axis that holds state:

| | Production | Staging |
|---|---|---|
| Branch and workflow | `main`, `deploy.yml` | `dev`, `deploy-staging.yml` |
| Image tags | `:<sha12>`, `:latest` | `:staging-<sha12>`, `:staging` (never `:latest`) |
| VPS directory | `~/motion-mcp` | `~/motion-mcp-staging` |
| Compose project | `motion-mcp` (directory name) | `motion-mcp-staging` (`-p`) |
| Data (`/data` volume, file stores) | `motion-mcp_motion-data` | `motion-mcp-staging_motion-data` |
| Host port | `127.0.0.1:8787` | `127.0.0.1:8788` |
| Env file | `~/motion-mcp/.env` | `~/motion-mcp-staging/.env` |
| Cloudflare Tunnel | production tunnel | its own tunnel and token |
| GitHub environment | `production` | `staging` |

The workflow reuses the repository-level `VPS_HOST`, `VPS_PORT`, `VPS_USER`
and `VPS_SSH_KEY` secrets, so staging lands on the production VPS. To use
another host, add those four secrets to the `staging` GitHub environment;
environment secrets override repository secrets. The GHCR pull uses the job
token, as in production. The workflow forces `HOST_PORT` and `PUBLIC_BASE_URL`
on the command line and stops before deploying when `~/motion-mcp-staging/.env`
is missing or its `CLOUDFLARE_TUNNEL_TOKEN` equals production's, because a
shared token would make the staging `cloudflared` serve production traffic.

One-time setup:

1. **Tunnel, DNS and TLS.** In Cloudflare Zero Trust, create a separate tunnel
   (for example `motion-mcp-staging`) and add the public hostname
   `staging.motion.digitop.ai` → `http://app:8787`. Cloudflare creates the
   proxied CNAME and terminates TLS; no reverse proxy or open port is needed.
   The hostname is two levels below `digitop.ai`, so its edge certificate must
   cover `*.motion.digitop.ai` the same way the one for `app.motion.digitop.ai`
   does. Optionally put a Cloudflare Access policy in front of it.
2. **Staging `.env`.** On the VPS, create `~/motion-mcp-staging/.env` from
   [`.env.example`](../.env.example) with values that are not production's:
   - `CLOUDFLARE_TUNNEL_TOKEN`: the staging tunnel's token;
   - `PUBLIC_BASE_URL=https://staging.motion.digitop.ai` and `ALLOWED_HOSTS`
     including `staging.motion.digitop.ai`;
   - fresh `MOTION_API_KEYS`, `ARTIFACT_SIGNING_SECRET` and
     `CREDENTIALS_ENCRYPTION_KEY`;
   - `STORAGE_DRIVER=local`, or a separate R2 bucket;
   - `POLAR_ENVIRONMENT=sandbox` with sandbox credentials, or Polar left empty;
   - a separate GitHub OAuth app whose callback is
     `https://staging.motion.digitop.ai/api/auth/oauth/github/callback`, set in
     `GITHUB_CALLBACK_URL`, or the GitHub variables left empty;
   - model keys (`OPENROUTER_API_KEY` and the rest), preferably with their own
     spend limits.
3. **First deploy.** Push to `dev`, or run *Deploy staging* from the Actions
   tab. The `staging` GitHub environment is created on first use; add
   protection rules there if wanted.

Gaps against ADR 0011: the compose stack has no PostgreSQL service yet (the app
uses the file stores on the `/data` volume), and the image does not include
ImageMagick because nothing uses it.
