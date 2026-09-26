# Motion MCP — Research Synthesis and Architecture v0.1

Sources: the four research reports in this folder (HyperFrames, ak-motion-video, multix, Pi/Jev/MCP), the bootstrap contract, and a read-only inspection of the target VPS. This file is the single input for `docs/` and the implementation plan.

## 1. Current capability map

| Need | Existing capability | How Motion MCP uses it |
|---|---|---|
| Composition format | HyperFrames HTML: root `data-composition-id`, `.clip` + `data-start/duration`, paused GSAP timeline in `window.__timelines[id]`, sub-compositions via `data-composition-src` + `<template>` | Compile target of Motion IR |
| Lint | `@hyperframes/lint` `lintProject` (in-process) | Gate after every build/patch |
| Runtime check | `hyperframes check --json` (lint + seek sweep: runtime errors, overflow/overlap, WCAG contrast, motion sidecars) | Mechanical visual QA input |
| Snapshots | `hyperframes snapshot --at … --describe false` (PNG) | Contact sheet (+ FFmpeg tile) |
| Keyframe diagnostics | `hyperframes keyframes --json` | Optional QA evidence |
| Render | `@hyperframes/producer` `createRenderJob`/`executeRenderJob` (draft/standard/high), CLI `render` | Preview (draft) and final renders |
| Editor | `@hyperframes/studio` + `studio-server`; simplest embed = `hyperframes preview --background --json` in an iframe | Dashboard editor (Phase 8) |
| Registry | 164 blocks, 223 components, `hyperframes add/catalog --json` | Optional scene building blocks for workers |
| Agent runtime | Pi `@earendil-works/pi-coding-agent` 0.87.1: `createAgentSession`, tool allow-list, custom TypeBox tools with `terminate:true`, extension hooks (`tool_call` can block), per-message usage + cost | Scene implementation and patch worker |
| Media providers | `@mrgoonie/multix` 0.7.0 CLI: 9 providers × image/edit/t2v/i2v/TTS/STT/music/SFX/upscale; `pi-multix` exposes it to Pi | Asset generation behind our registry |
| Motion knowledge | ak-motion-video (MIT): 61 style profiles with 14 dimensions and 19 scene types, deterministic resolver, audio/beat pipeline, pitfalls | Domain pack (lift and wrap) |
| Decision model | TypeSafe Jev (`/v1/systemone`, typed choice/score/probability, $0.042/M in, free out); OpenRouter only lists `typesafe/jev-router` (a chat router) | Jev adapter behind a decision interface |
| Frontier model | OpenRouter `anthropic/claude-opus-5.5` ($4/$20 per M, structured outputs) | Internal director |
| Cheap workers | OpenRouter `deepseek/deepseek-v4-flash` ($0.047/$0.094), `z-ai/glm-5.3-flash`, `qwen/qwen3.8-flash` | Pi coder model (configurable) |
| MCP transport | `@modelcontextprotocol/server` 2.1.0 `createMcpHandler` (stateless Streamable HTTP), `@modelcontextprotocol/express` bearer auth | Public MCP endpoint |

## 2. Gap analysis (what we must build)

1. **Motion IR, Taste Packet, Creative Spec, Scene Patch schemas** and a deterministic IR→HyperFrames compiler. Nothing upstream is renderer-neutral.
2. **Director protocol** with explicit `DirectorMode`, the host-opus spec contract, internal Opus prompts, and a scene-isolated critique bundle.
3. **Jev decision layer**: a typed `DecisionClient` with TypeSafe, OpenRouter-structured and rule adapters; routing policy for escalation, retries and render justification.
4. **Pipeline orchestrator** (execution graph, job state, retries, budgets) — Pi is the scene worker, not the job scheduler.
5. **Visual QA normalizer**: map `check`/lint/timeline output to a fixed issue taxonomy (clipping, overflow, contrast, empty frame, timing mismatch, safe area, collisions).
6. **Media layer**: multix runner with scrubbed env, static capability matrix, price table, FFmpeg transforms that multix lacks (tile, trim, concat, mux, loudnorm, faststart).
7. **Observability + cost**: hierarchical OTel-shaped spans with token/cost/COGS fields; multix and HyperFrames report no costs.
8. **Persistence, storage, auth, billing, search, Taste Memory, dashboard, marketing** — product layers around the engine.

HeyGen already hosts a HyperFrames MCP (cloud-only, OAuth). Motion MCP's differentiation is the taste layer (Director + Motion IR + Taste Memory), cost-aware routing, and self-hosted rendering.

## 3. Recommended architecture

```
MCP client ──► apps/mcp-server (Streamable HTTP, bearer auth, 8 public tools)
                   │ enqueue job
                   ▼
            packages/pipeline (execution graph, job store, budgets, traces)
     ┌──────────┬──────────┬───────────┬──────────────┬───────────┐
 director    jev-router  pi-runtime  hyperframes-    media
 (Opus via   (decision   (Pi SDK,     adapter        (multix runner,
 OpenRouter  client)     cheap coder) (compile, lint,  FFmpeg, registry)
 or host)                              check, snap,
                                       render)
     └── motion-ir (schemas) · domain-pack (retrieval) · observability · billing · storage · database · shared
```

Decisions (each has an ADR in `docs/decisions/`):
- **Monorepo**: pnpm workspaces, TypeScript (ESM, Node ≥ 22.19), vitest, biome.
- **Motion IR** is the contract; zod is the source of truth; JSON Schema is exported for host models.
- **Director mode is explicit** (`host-opus | internal-opus | custom`) per call, with a workspace default. Handshake: `motion_inspect({ target: "capabilities" })` returns the creative-spec JSON Schema, prompt guidance and pricing so a host Opus can author the spec itself.
- **Internal director** does Stage 1+2 in one structured call (creative direction + scene architecture) to avoid paying Opus twice for shared context. Critique (Stage 3) and polish (Stage 4) are gated by Jev.
- **Implementation is two-tier**: the deterministic compiler turns scene IR into valid HyperFrames HTML using typed motion primitives; Pi workers (cheap model) are used for scenes that need bespoke code and for patches. The deterministic path is the reliability floor and the CI path.
- **Jev** is a decision interface, not a chat model. Adapters: TypeSafe `systemone` (when `TYPESAFE_API_KEY` exists), OpenRouter structured output with a cheap model, deterministic rules. Every decision is typed and traced.
- **HyperFrames** hybrid: generate HTML ourselves, lint in-process, check/snapshot via CLI `--json`, render via producer. One pinned version (0.8.78). Telemetry and update checks off.
- **MCP server** is stateless (SDK v2 `createMcpHandler`); long work returns a `jobId` and clients poll with `motion_get_project`.
- **Persistence**: repository interfaces with a file-backed implementation for local and slice use and PostgreSQL (drizzle) in production; artifacts in R2 via S3 API with a local-disk driver.
- **Deployment**: Docker image (Node 22, Chrome headless shell, FFmpeg, ImageMagick) with docker compose on the VPS; public ingress through a Cloudflare Tunnel; marketing site on Cloudflare Workers static assets.

## 4. Motion IR v0.1 (summary; full spec in `docs/MOTION_IR.md`)

`MotionIR { version:"0.1", id, format{width,height,fps,duration,aspectRatio}, creative{concept,mood[],tone[],energy 1-5,visualDensity 1-5,emotionalArc}, brand{colors{background,foreground,accent,muted…},fonts{display,body,mono},radius,visualRules[]}, motionLanguage{tempo,preferredEasing[],avoidEasing[],cameraMotion,maxSimultaneousObjects,holdRatio,principles[],avoid[]}, audio?{…}, styleRefs?[], scenes: MotionScene[] }`

`MotionScene { id, index, role(hook|problem|mechanism|evidence|payoff|cta|title|transition|custom), intent, purpose, duration, focalPoint, layout{template(center|split|stack|grid|full-bleed|lower-third), align, safeArea}, elements: SceneElement[], choreography: Beat[], transitionIn/Out{kind,duration}, assetNeeds[], constraints[], antiPatterns[], acceptance[] }`

`SceneElement { id, kind(text|metric|code|shape|image|list|logo), role(hero|secondary|tertiary|annotation), content, style{size token, weight, color token}, position hint }` and `Beat { target, primitive(fade-in|fade-up|mask-reveal|type-on|scale-in|slide|draw|count-up|stagger|hold|exit), at (seconds or "after:<id>+0.2"), duration, easing token }`.

Renderer-neutral: no HTML, CSS selectors or GSAP names appear in the IR; easing and sizes are tokens that each compiler maps.

## 5. MCP tool contract v0.1 (full spec in `docs/MCP_API.md`)

Public: `motion_create`, `motion_edit`, `motion_inspect`, `motion_render`, `motion_search`, `motion_get_project`, `motion_list_projects`, `motion_publish`. Internal worker surface (Pi custom tools, not exposed publicly): `motion_read_spec`, `motion_scene_build`, `motion_scene_patch`, `motion_render_preview`, `motion_render_final`, `motion_snapshot`, `motion_visual_diff`, `motion_asset_generate`, `motion_asset_search`, `motion_audio_mix`, `motion_ffmpeg`, `motion_report`.

`motion_create({ brief, directorMode?, creativeSpec?, recipeId?, format?, quality?("preview"|"final"), budgetCredits? }) → { projectId, jobId, status, directorMode, next }`.

## 6. Execution graph (slice)

```
video.generate
├─ intent.normalize            deterministic
├─ jev.route (director?)       rules/Jev: host spec valid → skip Opus
├─ director.opus | director.host   Stage 1+2 → CreativeSpec (TastePacket + scene architecture)
├─ motion_ir.compile           deterministic CreativeSpec → MotionIR (+ domain-pack defaults)
├─ scenes.build (per scene)    deterministic compiler, or Pi worker when scene.needsCustomCode
├─ hyperframes.lint → hyperframes.check → snapshot.contact_sheet
├─ vision.qa                   normalize issues
├─ jev.classify (per issue)    mechanical → pi patch | asset → media | render → retry | creative → opus critique / host critique request
├─ revision (bounded, ≤ N loops, budget-checked)
├─ preview.render (draft) → final.render (standard/high)
└─ ffmpeg.finish               faststart, yuv420p, loudnorm when audio
```

## 7. Data model (production PostgreSQL; full list in `docs/ARCHITECTURE.md`)

users, workspaces, api_keys, projects, videos, scenes, versions, motion_ir_versions (JSONB), taste_packets (JSONB), taste_preferences, recipes, assets, renders, generation_jobs, model_calls, traces/spans, usage_events, credit_ledger, provider_credentials (encrypted), search_documents (tsvector + pgvector). Large binaries live in R2 only.

## 8. Roadmap

Phase 0 research (done) → 1 core schemas → 2 HyperFrames adapter → 3 Pi runtime → 4 Director → 5 Jev → 6 MCP server → vertical-slice E2E + deploy → 7 media → 8 dashboard → 9 search + Taste Memory → 10 Polar billing.

## 9. Repo structure

`apps/{mcp-server,marketing}` now; `apps/{dashboard,render-worker}` later. `packages/{shared,motion-ir,domain-pack,observability,billing,storage,database,director,jev-router,hyperframes-adapter,pi-runtime,media,pipeline}`; `packages/{search,taste-memory,recipes,auth}` land with their phases. `infra/{docker,cloudflare,scripts}`, `fixtures/golden/*`.

## 10. Architectural risks

1. HyperFrames ships near-daily; APIs for producer/studio change. Mitigation: exact pins, contract tests, CLI `--json` fallback.
2. Pi also moves fast (renamed scope within months). Mitigation: exact pin, wrapper package owns all Pi calls.
3. Pi `cwd` is not a sandbox. Mitigation: path-guard extension + container isolation + no public shell tool.
4. Jev access: no TypeSafe key yet; OpenRouter `jev-router` is not a decision API. Mitigation: adapter chain with rule fallback.
5. Windows capture is non-deterministic; production renders must run in the Linux image.
6. Render cost and latency dominate COGS; preview at draft quality and snapshot-first QA.
7. Brand-inspired style aliases carry legal risk; disabled by default.
8. VPS: `dev` user lacks Docker group access and sudo without password; production deploy is blocked until the owner grants it.
9. Taste quality of the deterministic compiler is bounded by its primitive vocabulary; Pi bespoke scenes widen it at higher cost.
