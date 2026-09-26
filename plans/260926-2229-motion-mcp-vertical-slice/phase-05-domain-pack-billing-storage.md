# Phase 05 — Domain pack, billing ledger, storage, database

## Context
Read `packages/motion-ir/src/*`, `packages/shared/src/*`, `plans/reports/researcher-260926-2229-ak-motion-video.md` (normalization plan and retrieval keys), `plans/reports/architecture-260926-2229-synthesis.md` §7. Source skill: `C:\Users\admin\.claude\skills\ak-motion-video\` (MIT, keep `LICENSE.txt` and attribution to `bestagentkits/motion-video-skill`).

## Files owned
`packages/domain-pack/**`, `packages/billing/**`, `packages/storage/**`, `packages/database/**`.

## Requirements
### packages/domain-pack
- `pack/` directory: vendor `references/styles/index.yaml` and `profiles/*.yaml` (keep files as-is; add `brand_inspired: true` flags in a separate `pack/overrides.yaml` rather than editing vendored files), plus `LICENSE-ak-motion-video.txt` and `ATTRIBUTION.md`-style notice inside `pack/NOTICE` (plain text, not markdown).
- Author normalized, paraphrased, concise files: `pack/principles.yaml` (not .md, to keep machine retrieval uniform), `quality-rubric.yaml`, `shot-patterns.yaml`, `typography.yaml`, `transition-patterns.yaml`, `visual-antipatterns.yaml`, `pacing-patterns.yaml`, `audio-mix.yaml`. Each entry: `id`, `text` (≤ 240 chars), and tags: `role` (director|worker|both), `scene_types[]`, `styles[]`, `format[]`, `energy[]`, `pipeline_step`, `invariant` (bool). Adapt entries to the Motion IR vocabulary (roles hook/problem/mechanism/evidence/payoff/cta, primitives, tokens) so they are directly usable by our director and workers. No verbatim copying of long passages.
- `DomainPack` API: `load()` (parse YAML once, cache), `retrieve({ role, sceneRole?, styleIds?, format?, energy?, step?, limit, maxChars })` → ranked snippets (invariants first, then tag-match score), `styleIndex({ excludeBrandInspired: true })` → compact list for the director, `findStyles(query)` → keyword match. Output is plain strings sized for prompts (enforce `maxChars`).
- Tests: retrieval returns only matching tags, invariants always included, budgets enforced, brand-inspired styles excluded by default, every YAML entry passes a zod schema.

### packages/billing
- Credits: `1 credit = $0.01`. `CREDIT_PRICES` per billable operation (creative_direction, creative_critique, render_minute_hd, render_minute_4k, preview_render, image_generation, video_generation_second, tts_1k_chars, music_track, sfx, storage_gb_month, api_call, orchestration_job) with a documented target margin; BYOK rules (provider costs waived, platform/orchestration/render/storage/Opus still charged).
- Double-entry `CreditLedger` over a `LedgerStore` interface (in-memory + file JSONL implementations): `grant` (top-up from Polar order), `reserve` (hold before a job), `capture` (actual usage), `release`, `balance`, idempotency keys, no negative balances unless an overdraft limit is set. `quoteJob(plan)` estimates credits for a video job before running.
- `polar.ts`: verify Polar webhook signatures (Standard Webhooks spec: `webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256 with the base64 secret) and map `order.paid` → ledger grant. No network calls in tests.
- Tests: ledger invariants (sum of entries = balance, idempotency, reserve/capture/release), quote math, webhook signature verification (valid, tampered, expired).

### packages/storage
- `ArtifactStore` interface: `put(key, file|buffer, contentType)`, `get`, `exists`, `url(key, { expiresIn })`, `delete`, `list(prefix)`. `LocalArtifactStore` (under DATA_DIR/artifacts, safe key validation, no path traversal) and `R2ArtifactStore` (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, endpoint `https://<account>.r2.cloudflarestorage.com`, region `auto`). Key layout helper: `workspaces/<ws>/projects/<project>/{renders,snapshots,assets,compositions}/…`.
- Tests: local store round trip + traversal rejection. R2 live test only when R2 env vars exist (`*.live.test.ts`): put/get/delete a tiny object under a `test/` prefix.

### packages/database
- Repository interfaces: `ProjectRepo`, `JobRepo`, `ApiKeyRepo`, `TraceRepo`, `UsageRepo` with entity types: Project { id, workspaceId, title, brief, directorMode, status, tastePacket?, creativeSpec?, motionIR?, irVersion, artifacts {preview?, final?, contactSheet?, projectDir}, createdAt, updatedAt }, Job { id, projectId, kind (create|edit|render), status (queued|running|succeeded|failed|cancelled|awaiting_host), progress {stage, pct, message}, error?, result?, traceId?, createdAt, updatedAt }, ApiKey { id, workspaceId, name, hash (sha256), prefix, createdAt, revokedAt? }.
- `FileRepository` implementation (JSON files under DATA_DIR/db with atomic write via temp+rename and a per-file mutex) — real persistence for local and single-node deploys.
- `schema.ts`: drizzle-orm PostgreSQL schema for the full production data model (users, workspaces, projects, videos, scenes, versions, motion_ir_versions JSONB, taste_packets JSONB, taste_preferences, recipes, assets, renders, generation_jobs, model_calls, traces, usage_events, credit_ledger, api_keys, provider_credentials (encrypted bytea + key id), search_documents with tsvector + vector column) — schema only plus `drizzle.config.ts`; a Postgres repository implementation is a later phase.
- API key helpers: `generateApiKey()` → `mmcp_<random>` returned once, stored as sha256 hash; `verifyApiKey` constant-time.
- Tests: file repo CRUD + concurrent writes, API key hash/verify.

## Validation
`pnpm typecheck`, `pnpm lint`, `pnpm test` green.
