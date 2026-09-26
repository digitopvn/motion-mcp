# Phase 04 — Pi runtime and media layer

## Context
Read `packages/motion-ir/src/*`, `packages/shared/src/*`, `packages/observability/src/tracer.ts`, `plans/reports/researcher-260926-2229-pi-jev-mcp.md` §A (Pi SDK), `plans/reports/researcher-260926-2229-multix.md`, `plans/reports/researcher-260926-2229-ak-motion-video.md` §2 (deterministic audio steps). HyperFrames composition format: `plans/reports/researcher-260926-2229-hyperframes.md` §3.

## Files owned
`packages/pi-runtime/**`; `packages/media/**` except `packages/media/src/ffmpeg.ts` and its test (phase 02 writes those; your `packages/media/src/index.ts` must `export * from "./ffmpeg.ts"` — create a minimal placeholder only if the file does not exist yet when you typecheck, and coordinate by not changing its exports).

## Requirements
### packages/pi-runtime
- Depend on exact `@earendil-works/pi-coding-agent@0.87.1` and `@earendil-works/pi-ai@0.87.1` (+ `typebox` as needed). Verify the real exported API from the installed package types before coding; adapt the research sample to reality.
- `PiWorker.buildScene({ projectDir, sceneId, sceneIR, contract, skills, model, span, signal })` and `PiWorker.patchScene({ projectDir, sceneId, patch (deferred instructions), qaIssues, ... })`: runs an in-process Pi session with `cwd = projectDir`, tools allow-list `read, write, edit, ls, grep, find` (no bash by default; `bash` only when `allowBash` is true), a custom terminating `submit_scene` tool returning `{ files, notes }`, `thinkingLevel: "off"`, compaction off, max turns/time budget, in-memory session. Model from config (`CODER_MODEL`, OpenRouter provider, key injected via runtime API key, never in the prompt).
- Path guard extension: block any tool call whose path resolves outside `projectDir` or into `motion-ir.json`/`hyperframes.json` unless allowed; block writes to anything but `compositions/<sceneId>.html` for scene tasks.
- Task prompt builder: minimal context (scene IR JSON, composition contract summary, relevant domain-pack snippets passed in as strings, lint/QA issues for patches). Keep under ~6k input tokens.
- Stream Pi events into the tracer: a `pi.execute` span with `scene.<id>` children; `recordModelCall` per assistant message usage/cost; tool calls as span attributes/events; use `getSessionStats()` totals when available.
- Export a `SceneWorker` interface so the pipeline can swap Pi for another runtime.
- Unit tests must not hit the network: test the path guard, prompt builder size, and the event→trace mapping using Pi's faux/test provider if the package offers one (check `@earendil-works/pi-ai` for a faux/mock provider); otherwise test the mapping functions directly. Live test (`*.live.test.ts`) builds one scene with the real CODER_MODEL when `OPENROUTER_API_KEY` is set.

### packages/media
- `MultixRunner`: runs pinned `@mrgoonie/multix@0.7.0` CLI via `process.execPath <resolved cli.js>` with argv arrays, a controlled temp cwd, `scrubbedEnv` plus only the provider keys needed for the chosen provider, `MULTIX_DISABLE_HOME_ENV=1`, `MULTIX_OUTPUT_DIR` set, explicit `--output`; parses output paths from stdout; never runs `multix check` output to models.
- `ProviderRegistry` + static `CAPABILITY_MATRIX` (capability → providers → argv builder → required env keys) for: image.generate, image.edit, video.t2v, video.i2v, audio.tts, audio.stt, audio.music, audio.sfx, image.upscale. `available(capability, env)` filters by key presence. `generateAsset({ capability, prompt, params, preferProviders }, span)` with fallback across providers on failure.
- `PRICE_TABLE` (provider+model+unit → USD) with clearly marked "indicative" values and `estimateAssetCost`; record `addCost("asset", …)` on spans.
- `packages/media/src/index.ts` exports runner, registry, prices, and `./ffmpeg.ts`.
- Tests: argv building per provider, env scrubbing (no unrelated secrets passed), capability availability, fallback order with a fake runner, stdout path parsing.

## Validation
`pnpm typecheck`, `pnpm lint`, `pnpm test` green.
