# Phase 05 report: domain pack, billing, storage, database

Date: 2026-09-26. Status: done with concerns (root `pnpm lint` fails on files owned by other phases; R2 bucket missing).

## Built API

### @motion-mcp/domain-pack
- `pack/`: vendored `styles/index.yaml` + 61 `styles/profiles/*.yaml` (unmodified), `LICENSE-ak-motion-video.txt` (MIT, BestAgentKits), `NOTICE` (plain text attribution to bestagentkits/motion-video-skill @ a73702b), `overrides.yaml` (39 `brand_inspired: true` flags).
- Eight authored, paraphrased knowledge files: 109 entries. Each entry has `id`, `text` (240 chars or fewer), and `tags {role, scene_types, styles, format, energy, pipeline_step, invariant}`. Tags use Motion IR vocabulary: SceneRole, AspectPreset, primitives, tokens, TransitionKind.

| File | Entries | Invariants |
|---|---|---|
| principles | 19 | 7 |
| quality-rubric | 16 | 3 |
| shot-patterns | 15 | 0 |
| typography | 12 | 3 |
| transition-patterns | 11 | 1 |
| visual-antipatterns | 13 | 4 |
| pacing-patterns | 13 | 0 |
| audio-mix | 10 | 3 |

- `DomainPack`:
  - `load()` parses and validates once (cached, concurrency-safe). It checks the zod schemas, that profile ids match the index, that overrides and style tags reference known styles, and that entry ids are unique.
  - `loadDomainPack()` keeps one shared instance per process.
  - `retrieve({ role, sceneRole?, styleIds?, format?, energy?, step?, kinds?, limit=12, maxChars=3000 })` returns `{ snippets, text, truncated }`, with `text.length <= maxChars`.
  - `styleIndex({ excludeBrandInspired = true })` and `styleIndexText()` give the compact style list.
  - `findStyles(query, { includeBrandInspired = false })` does keyword matching.
  - `getStyleProfile(id)` returns one full profile.
- Retrieval semantics:
  - Invariants come first. They are filtered only by role, step (`any` matches every step) and `kinds`; scene, style, format and energy never exclude them.
  - Other entries must match every facet the query sets; an empty tag list on an entry acts as a wildcard. They are ranked by explicit matches: +2 each for scene, format, energy and style, +1 for step.
  - Invariants are scoped by step because the full worker invariant set (21 entries, about 3.6k chars) would otherwise use up the default budget.

### @motion-mcp/billing
- `CREDIT_PRICES` (below), `priceOf`, `priceMargin`, `quoteJob(plan)` returning per-line and total credits and USD.
  - In host-opus mode no director call is billed.
  - With BYOK, provider operations are waived; orchestration, render, storage, API and Opus are still charged.
- `CreditLedger` (double-entry) over the `LedgerStore` interface, with two stores:
  - `InMemoryLedgerStore`.
  - `JsonlLedgerStore`: fsync on append, replays on load, truncates a torn final line, fails loudly on corruption.
- Ledger operations: `grant`, `reserve`, `capture` (refunds unused credits; an overrun draws on available credits), `release`, `balance`, `getReservation`. Idempotency keys detect reuse across operation, workspace or reservation. Mutations are serialized. Balances cannot go negative unless an `overdraftLimit` is set. Accounts are `workspace:<id>:available|held`, `source:<src>` and `platform:usage`.
- `polar.ts`:
  - `verifyWebhook`: Standard Webhooks HMAC-SHA256 on `id.timestamp.body`, supporting multiple `v1,` signatures, a ±300 s window and constant-time comparison. A `whsec_` secret is base64-decoded; a plain Polar secret is used as its UTF-8 bytes, which is what Polar's SDK effectively does.
  - `polarOrderToGrant`: the workspace comes from `metadata.workspace_id` or `customer.external_id`. Credits come from the `creditsByProduct` map, else from the USD `net_amount` in cents.
  - `handlePolarWebhook`: `order.paid` becomes an idempotent grant keyed `polar:order:<id>`. Other events are acknowledged.

### @motion-mcp/storage
- `ArtifactStore` interface with two implementations:
  - `LocalArtifactStore` stores files under `<DATA_DIR>/artifacts` with atomic temp+rename writes. Keys are validated with a strict segment regex and re-checked against the root. `url()` returns a `file://` URL, or `<publicBaseUrl>/<key>` when a base URL is configured.
  - `R2ArtifactStore` uses the S3 client with region `auto`, endpoint `https://<account>.r2.cloudflarestorage.com` and presigned GET URLs capped at 7 days. Errors are mapped to MotionError PROVIDER/NOT_FOUND.
- Key layout helpers: `projectPrefix`, `artifactKey({workspaceId, projectId, kind, name})`.
- `createArtifactStore(config, { localPublicBaseUrl? })`.

### @motion-mcp/database
- Zod entities: Project, Job, ApiKey, TraceRecord, UsageEvent.
- Repository interfaces: ProjectRepo, JobRepo, ApiKeyRepo, TraceRepo, UsageRepo, and the aggregate `Repositories`.
- `FileRepository`:
  - Stores one JSON file per record under `<DATA_DIR>/db/<collection>/<id>.json`.
  - Writes are atomic (temp+rename, with retries for Windows EPERM/EBUSY) under a per-file `KeyedMutex`.
  - Updates are read-modify-write under that lock. Records are validated on read and write, and ids are validated so paths cannot traverse.
- API keys: `generateApiKey()` returns `mmcp_` plus 43 base64url characters (256 bits) together with its sha256 hash and a 12-character display prefix. Also `hashApiKey`, `isApiKeyFormat`, and `verifyApiKey` (constant time).
- `schema.ts` (exported as `pgSchema`) defines the full drizzle PostgreSQL model in 20 tables:
  - users, workspaces, api_keys, projects, videos, scenes, versions
  - motion_ir_versions and taste_packets (JSONB), taste_preferences, recipes, assets, renders
  - generation_jobs, model_calls, traces, usage_events
  - credit_ledger: one row per transaction with JSONB entries, a unique idempotency key and denormalized deltas
  - provider_credentials: bytea ciphertext + nonce + key_id
  - search_documents: a generated tsvector with a GIN index, and vector(1536) with an HNSW cosine index
- `drizzle.config.ts` sits at the package root.

## Credit price table (1 credit = $0.01, target margin at least 60%)

| Operation | Unit | Credits | Est. COGS | Margin | BYOK waivable |
|---|---|---|---|---|---|
| creative_direction | director call | 100 | $0.40 | 60% | no |
| creative_critique | critique pass | 40 | $0.15 | 62.5% | no |
| render_minute_hd | output minute | 25 | $0.08 | 68% | no |
| render_minute_4k | output minute | 80 | $0.30 | 62.5% | no |
| preview_render | draft preview | 8 | $0.03 | 62.5% | no |
| image_generation | image | 10 | $0.04 | 60% | yes |
| video_generation_second | second | 25 | $0.10 | 60% | yes |
| tts_1k_chars | 1k chars | 15 | $0.06 | 60% | yes |
| music_track | track | 100 | $0.40 | 60% | yes |
| sfx | effect | 5 | $0.02 | 60% | yes |
| storage_gb_month | GB-month | 5 | $0.015 | 70% | no |
| api_call | call | 1 | $0.002 | 80% | no |
| orchestration_job | job | 20 | $0.08 | 60% | no |

Why these margins:
- A 60% floor covers retries, failed renders, free-tier leakage, payment fees (Polar about 4% + 40¢) and support.
- COGS estimates use list prices with no volume discounts and include one retry.
- Render prices carry extra headroom because render compute dominates COGS (architecture risk 6).
- A unit test enforces the floor for every operation.
- Example: a 30 s HD internal-opus job with 2 previews, 1 critique, 1.5k TTS characters and 1 music track is quoted at 312 credits ($3.12).

## Tests

- `pnpm vitest run --project unit packages/domain-pack packages/billing packages/storage packages/database`: 4 files, 59 tests, all pass.
- Root `pnpm test`: 18 files, 166 tests, all pass.
- Root `pnpm typecheck`: passes.
- `biome check` on the four packages: clean.
- R2 live test (`pnpm vitest run --project live packages/storage`): FAIL. The credentials authenticate, but the bucket named in `.env` does not exist (`NoSuchBucket`). The test is correct; the bucket has to be created or `R2_BUCKET_NAME` fixed.

## Open issues

1. Root `pnpm lint` fails with about 1148 errors, all in files outside this phase:
   - `packages/hyperframes-adapter/tmp/out/**/gsap.min.js`, `packages/hyperframes-adapter/tmp/try.ts`
   - `apps/marketing/.wrangler/tmp/**`
   - `tsconfig.json` and `biome.json` formatting
   - motion-ir, shared, pi-runtime and mcp-server tests

   Biome's `useIgnoreFile` does not exclude these generated `tmp`/`.wrangler` dirs. Root fix needed: add `!**/tmp` and `!**/.wrangler` to `biome.json` `files.includes` (or clean the dirs), then format `tsconfig.json`.
2. R2 bucket missing (see above). Creating it is an infrastructure action for the owner.
3. `FileRepository` and `JsonlLedgerStore` lock per process only. Deploy them single-writer per data dir; multi-node needs the Postgres repos (a later phase).
4. Local `url()` returns `file://` unless the server passes `localPublicBaseUrl`. Phase 06 has to decide whether the MCP server serves `<DATA_DIR>/artifacts`.
5. The Polar field names (`net_amount`, `metadata.workspace_id`, `customer.external_id`) follow Polar's current order schema. Checkout creation in a later phase must set `metadata.workspace_id` or `external_customer_id`.
