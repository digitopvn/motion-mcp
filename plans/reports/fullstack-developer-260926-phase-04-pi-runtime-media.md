# Phase 04 report: Pi runtime and media layer

Date: 2026-09-26. Status: done. Owned files only; the Phase 02 files `packages/media/src/ffmpeg.ts` and its test were not touched.

## Built API

### `@motion-mcp/pi-runtime`
- `SceneWorker` interface (`name`, `buildScene`, `patchScene`) lets the pipeline swap Pi for another runtime.
- `PiWorker` implements it. `PiWorker.create({ apiKey, model, provider?, maxTurns?, timeoutMs?, allowBash?, agentDir? })` and `PiWorker.fromConfig(config)` use `OPENROUTER_API_KEY` and `CODER_MODEL`.
  - Keys: an in-memory credential store and models store, the bundled catalog only (no network refresh), and the key passed through `setRuntimeApiKey`. The key is registered for redaction and never enters a prompt.
  - Session: `cwd = projectDir`, `thinkingLevel: "off"`, compaction off, retry max 2, in-memory session and settings, project trust off, analytics and telemetry off.
  - Resource isolation: a private temp `agentDir`, and no extensions, skills, prompt templates, themes or context files. The system prompt is a short custom one.
  - Tools: the allow-list `read, write, edit, ls, grep, find`, plus `bash` only when `allowBash` is set, plus the custom `submit_scene` tool. `submit_scene` checks that the scene file exists and is not empty, then returns `terminate: true`; wrong files are rejected and the model is asked to retry.
  - Budgets: a turn limit that aborts the run with `BUDGET_EXCEEDED`, a time limit (`TIMEOUT`), and an `AbortSignal` (`CANCELLED`). If the run ends without a submission, it fails with a retryable `PROVIDER` error that carries the redacted model error.
- `createPathGuard` plus an inline extension on Pi's `tool_call` hook. The guard applies Pi's own path normalization (`@` prefix, `~`, Git-Bash drive paths, `file://`, unicode spaces) and follows symlinks of the nearest existing ancestor. It blocks:
  - paths outside `projectDir`;
  - `find`/`grep` glob patterns that escape the project;
  - `motion-ir.json` and `hyperframes.json` (reads are allowed only with `allowProtectedReads`);
  - writes to anything except `compositions/<sceneId>.html`;
  - unknown tools, and `bash` or `powershell` unless opted in.
- `buildScenePrompt` / `buildPatchPrompt` build the task prompt from:
  - the scene IR JSON, a compact video context (format, brand, motion language) and the composition contract (`DEFAULT_COMPOSITION_CONTRACT`, overridable);
  - domain-pack snippets, which are trimmed to fit `MAX_TASK_PROMPT_TOKENS = 6000`;
  - for patches, the patch instructions and at most 20 QA issues, errors first.
- `createPiTraceMapper`: spans are `pi.execute` → `scene.<id>`.
  - Each assistant message's usage and cost becomes one `recordModelCall`.
  - Tool calls, tool errors, blocked calls, turns and the stop reason become span attributes.
  - `auto_retry_start` becomes a span retry.
  - `getSessionStats()` totals are copied to `pi.session.*` attributes.

### `@motion-mcp/media`
- `MultixRunner` / `MediaCommandRunner`:
  - Launch: the pinned `@mrgoonie/multix@0.7.0` is resolved by walking up to `<pkg>/dist/cli.js` and run with `process.execPath` (`MULTIX_BIN` overrides this). Arguments are an argv array, and each call gets a throwaway temp cwd.
  - Environment: `scrubbedEnv` plus only the chosen provider's keys, `MULTIX_DISABLE_HOME_ENV=1`, `MULTIX_OUTPUT_DIR` and `NO_COLOR=1`.
  - Safety: `multix check` and `multix update` are refused. Errors are redacted, and a successful exit that produces no file is treated as an error.
  - Outputs: `parseOutputPaths` handles paths with spaces under the output dir and generic absolute paths. `existingOutputs` keeps only real files inside the output dir.
- `CAPABILITY_MATRIX`: nine capabilities, each mapped to ordered provider routes with required env keys, an argv builder, an extension and a price unit. The argv was checked against `--help` of the pinned 0.7.0.
  - Model-authored text is passed as `--flag=value`, and positional prompts go after `--`, so text cannot inject options.
- `ProviderRegistry`: `available(capability, env)`, `describe()`, `plan()`, and `generateAsset({ capability, prompt, params, preferProviders, models, name, outputDir, timeoutMs }, span, signal)`.
  - Inputs are validated with zod.
  - It falls back across providers in preference order, then matrix order.
  - Spans: an `asset.<capability>` span with one child `asset.<provider>` span per attempt. Retries are counted, and `addCost("asset", …)` is recorded on the successful attempt.
- `PRICE_TABLE`: every entry is flagged `indicative: true`. `findPrice` and `estimateAssetCost` take a unit (image, video_second, kchar, audio_minute, audio_second or generation) and return `priced: false` when no entry matches.
- `index.ts` exports the runner, matrix, registry, prices and `./ffmpeg.ts`.

## Pi SDK surface: verified against the installed 0.87.1 types (compared with the research sample)
- The following match the research: `createAgentSession`, `ModelRuntime.create` / `setRuntimeApiKey` / `getModel`, `SessionManager.inMemory`, `SettingsManager.inMemory`, `DefaultResourceLoader`, `defineTool`, `terminate: true`, `pi.on("tool_call")` → `{ block, reason }`, `session.subscribe`, `getSessionStats`.
- Differences:
  - `Type` is re-exported from `@earendil-works/pi-ai`, so no direct `typebox` dependency is needed.
  - `getModel` comes from `ModelRuntime`, not `pi-ai/compat`.
  - `ModelRuntime.create` accepts `credentials` (`InMemoryCredentialStore`), `modelsStore` (`InMemoryModelsStore`), `modelsPath: null` and `allowModelNetwork: false`. Without these it defaults to `~/.pi/agent/auth.json`.
  - Inline extensions are passed through `DefaultResourceLoader({ extensionFactories })`. They still load when `noExtensions: true` is set.
  - The `systemPrompt` option replaces only Pi's preamble (the long Pi-docs block); tool snippets, append prompts and the cwd section remain.
  - There is no built-in max-turns option, so turns are counted through `turn_start` and enforced with `session.abort()`.
- `pi-ai` ships a faux provider (`fauxProvider`, `fauxToolCall`, `fauxAssistantMessage`), registered with `ModelRuntime.registerNativeProvider`. The unit tests run real Pi sessions, tools and guard offline against it.
- `deepseek/deepseek-v4-flash` is present in the bundled OpenRouter catalog (386 models).

## Tests
- `pnpm typecheck`: pass.
- `pnpm test`: pass (18 files, 165 tests at the time of the run). The phase's own tests are 7 files and 54 tests: path guard, prompt budget, trace mapping, the faux end-to-end worker, argv per provider, env scrubbing, availability, fallback order, stdout parsing, and a runner run against a stand-in CLI.
- `pnpm lint`: fails only on files outside this phase: `packages/media/src/ffmpeg.ts` and `packages/media/test/ffmpeg.test.ts` (Phase 02, formatting only), `packages/pipeline/package.json`, and `apps/marketing/.wrangler/tmp/**`. The owned files are biome-clean.
- Live test (`pnpm vitest run --project live packages/pi-runtime`) with the real `CODER_MODEL` via OpenRouter passed. It built `compositions/intro.html` in 8 turns and about 22 s, using 6,008 input and 2,176 output tokens, at $0.00069.

## Open issues
1. Root lint fails on the foreign files listed above. `.wrangler/tmp` should probably be added to the biome ignores, which is a root config change.
2. The prices are indicative list prices. They need reconciling against invoices before they drive customer pricing.
3. The video, music and upscale argv are checked against `--help` only; no paid provider call has been made. `fal video` and `fal run` rely on stdout parsing because they have no `--output` flag.
4. The path guard cannot constrain `bash`. Keep `allowBash` off unless the job runs in a container.
5. A `CODER_MODEL` missing from Pi's bundled catalog fails with `CONFIG`. Registering custom models through `models.json` was left out because nothing currently needs it.
