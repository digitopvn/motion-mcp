# Research: multix-cli and pi-multix as the Motion MCP media layer

Date: 2026-09-26. Evidence: shallow clones of `mrgoonie/multix-cli` (HEAD 2026-09-24) and `bestagentkits/pi-multix` (HEAD 2026-09-24), `npm view`, and live `npx -p @mrgoonie/multix@0.7.0 multix <group> --help` output.

## Bottom line

Adopt multix as the provider layer and do not write provider clients, but wrap it the way pi-multix does: spawn the CLI with `execFile` and an argv array. There is no usable programmatic provider API, no global `--json` flag, and no cost metadata, so Motion MCP must own three thin layers itself: a static capability matrix, stdout parsing for output paths (or pinning outputs with `--output`), and usage/cost accounting. Use pi-multix directly only if the agent-facing tool surface is acceptable as-is; for Motion MCP's own registry, reuse its argv tables and runner design rather than depending on it, because it currently bundles an older multix (see risks).

## 1. multix-cli

- **Package:** `@mrgoonie/multix` (the name `multix-cli` does not exist on npm). Latest `0.7.0` (published 2026-09-24), `beta` tag `0.1.0-beta.2` (stale). Bin `multix` -> `dist/cli.js`, ESM only, `engines.node >=20`. Deps: commander, dotenv, execa, undici, zod. 17 releases since 2026-05; 0.x semver, so minors may break.
- **Install:** `npm i -g @mrgoonie/multix`, or `npx -y -p @mrgoonie/multix@<ver> multix ...` (what the local `ak:ai-multimodal` skill does, with `@latest --prefer-online`). `multix update [--check] [--tag] [--dry-run]` self-updates a global install (0.7.0+).
- **Command surface (0.7.0, from live `--help`):**
  - `check [-v]`: tooling, key presence, live Gemini ping. `update`.
  - `gemini`: analyze, transcribe, extract, generate (Imagen/Nano Banana), i2i (multi-ref), generate-video (Veo, experimental), i2v `<imagePath>`, generate-speech.
  - `openai`: generate, i2i (`--driver api|codex|auto`), generate-speech, transcribe.
  - `minimax`: generate, i2i (subject preservation only, not editing), generate-video (Hailuo; `--first-frame <url>` gives i2v), generate-speech, generate-music.
  - `openrouter`: generate, i2i, i2v (HTTPS image URL, async), video-status `<jobId>`, video-models.
  - `leonardo`: generate `<prompt>`, i2i (Leonardo image id), video `<prompt>`, i2v `<imageId>`, video-models, upscale `<generatedImageId>`, variation, status, models, me.
  - `byteplus`: generate, i2i, video, i2v `<image>`, reference-to-video (<=9 img/3 vid/3 audio), generate-3d, status `<taskId> [--wait --download]`.
  - `cloudflare`: generate (FLUX.1 Schnell), generate-speech (MeloTTS), generate-video (Replicate via AI Gateway), video-status.
  - `elevenlabs`: tts, voices, clone, voice-changer, transcribe, sfx, music, dub, dub-status, isolate, align, account, models.
  - `fal` (0.7.0+): `run <model> --input <json|@file>` (any fal queue model), image, video, status, result.
  - `media`: optimize (`--target-size/--quality/--max-width/--bitrate/--resolution`), split, batch. `doc convert` (Gemini).
- **Flags:** per-command, no global set. Common: `--prompt`, `--model/-m`, `--output <path>`, `-v/--verbose`; images add `--image-format webp|original`, `--no-webp`; async jobs add `--wait`, `--wait-timeout <ms>`, `--download`, `--no-thumb`. Leonardo takes the prompt positionally; i2v takes the image positionally for gemini/leonardo/byteplus.
- **`--json`: does not exist.** Success output is human text on stdout, e.g. `Generated N image(s):` followed by indented absolute paths (`src/providers/openai/commands/generate.ts`). Raw JSON is printed only by some commands: `fal run --no-download`, `fal status/result`, `byteplus status`, `elevenlabs voices/dub-status`, and `gemini analyze --format json`. The internal `Result<T>` type (`{status:"success",...}|{status:"error",error}`) never reaches stdout. Logger writes info to stdout with ANSI colors only when a TTY is attached and `NO_COLOR` is unset.
- **Exit codes:** 0 on success; 1 for any failure (uncaught errors print `Error: <msg>` to stderr in `src/cli.ts`); 2 in one validation path (`byteplus reference-to-video`). No granular codes; the error classes (`CONFIG_ERROR`, `PROVIDER_ERROR`, `VALIDATION_ERROR`, `HTTP_ERROR`) exist only as message text.
- **Output files:** default `./multix-output` relative to cwd, overridable by `MULTIX_OUTPUT_DIR` or `--output`. Generated images are re-encoded to WebP with `cwebp` by default (skipped with a warning if `cwebp` is absent). Providers choose the container, so `--output out.png` can hold JPEG bytes. Video commands may also download a thumbnail beside the file.
- **Programmatic API:** `import` of `@mrgoonie/multix` exports only `src/core` (errors, Result helpers, `loadEnv/resolveKey/redact`, `getOutputDir`, `httpJson/downloadFile`, logger). Provider functions are not exported; the pi-multix maintainers explicitly rejected deep `dist/` imports as unstable. Treat the CLI argv as the contract.

## 2. pi-multix

- **What:** a Pi package (`pi-multix@0.1.6`, npm, MIT, 2026-09-23) with `package.json` `"pi": { "extensions": ["./dist/index.js"], "skills": ["./skills"] }`. It registers tools and ships a `multix` provider-selection skill.
- **Install:** `pi install npm:pi-multix` (also `@version`, `git:github.com/bestagentkits/pi-multix`, `-l` for project-local). It depends on `@mrgoonie/multix`, so no separate CLI install is needed.
- **Registration:** default export `piMultix(pi: ExtensionAPI)` calls `pi.registerTool(tool)` for eight `defineTool` definitions with TypeBox schemas (peer deps on `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `typebox`; developed against pi 0.85.1 / typebox 1.3.7, while pi is now 0.87.1).
- **Tools (discriminated by `action` + `provider`):** `multix_check`; `multix_models` (actions providers|models|scaffold|set-key|unset-key); `multix_image` (generate|i2i; gemini, openai, openrouter, byteplus, minimax, leonardo, cloudflare); `multix_video` (generate|i2v|status); `multix_audio` (tts|transcribe|music|sfx|clone); `multix_media` (optimize|split|batch); `multix_doc` (convert|analyze|extract); `multix_run` (raw `args[]` escape hatch). All accept `cwd`, `timeoutMs` (default 10 min, 15 for video, max 1 h), `verbose`, `extraArgs`.
- **Behavior:** per-provider param->flag tables reject unsupported params with an error listing the allowed set; argv order is table-driven and deterministic. Non-zero exit throws with exit code, stdout, and stderr. `multix_image` sniffs magic bytes and renames mislabeled outputs. Results are text, not structured; `details` carries only `argv`, `phase`, `exitCode`, `durationMs`.
- **Config:** `MULTIX_BIN` (override CLI path or command name) and `MULTIX_OUTPUT_DIR`. CLI resolution walks up for `node_modules/@mrgoonie/multix/dist/cli.js` and runs it with `process.execPath` (Windows-safe, avoids `.bin` shims), then falls back to `multix` on PATH.

## 3. Building a capability matrix

multix has no `capabilities` or `list-providers` command. Build the matrix from three sources:

1. **Static command map (authoritative):** capability -> (provider, argv prefix). Seed it from `pi-multix/docs/provider-matrix.md` plus the help output above. Resulting coverage: image gen (7 providers + fal), image edit (gemini, openai, openrouter, byteplus, leonardo; minimax subject-only), t2v (gemini, minimax, leonardo, byteplus, cloudflare, fal), i2v (gemini, leonardo, byteplus, openrouter, minimax via `--first-frame`, fal), TTS (openai, gemini, minimax, elevenlabs, cloudflare), STT (openai, gemini, elevenlabs), music (minimax, elevenlabs), SFX (elevenlabs only), upscale (leonardo only, or any fal upscaler via `fal run`), 3D (byteplus), local transforms (`media optimize|split|batch` only).
2. **Availability (per request/tenant):** key presence from env (`check` prints presence but also partially redacted keys; see section 5). Computing presence yourself from the key map in `docs-site/.../reference/environment.md` is cheaper and safer.
3. **Live model catalogs (only four):** `openrouter video-models`, `leonardo models`, `elevenlabs models`, and `elevenlabs voices` call provider APIs. `leonardo video-models` is a static enum. Every other provider's models are hard-coded defaults in `src/providers/*/models.ts` or env overrides (`IMAGE_GEN_MODEL`, `OPENAI_IMAGE_MODEL`, `FAL_VIDEO_MODEL`, and so on). Catalog output is text, so parse it or call provider catalog APIs directly.

Gap for Motion MCP: multix covers only compress/resize/split for ffmpeg/ImageMagick. Arbitrary transforms (trim, concat, overlay, crop, format convert, audio mux) are not exposed, so Motion MCP needs its own ffmpeg/ImageMagick wrapper for those.

## 4. Cost and pricing metadata

multix exposes no pricing table and prints no per-call cost. Scattered signals exist only in verbose logs or account commands: OpenRouter video `usage.cost` (logged at debug level in `video-status`), Leonardo `apiCreditCost` in response types (not printed) and `leonardo me` remaining credits, ElevenLabs `account` usage, and BytePlus token `usage` in types. Motion MCP must own a price table keyed by provider+model+unit (image, second of video, character, minute of audio) and record usage from the request parameters it sends.

## 5. Security

- Keys come from environment only: `process.env`, then `<cwd>/.env`, then `~/.multix/.env` (dotenv `override:false`, so process env wins). No CLI flag accepts a key. `MULTIX_DISABLE_HOME_ENV=1` skips the home file.
- **Risk: `<cwd>/.env` is loaded automatically.** If Motion MCP runs multix inside a user-controlled workspace, a planted `.env` can inject keys, base URLs (`LEONARDO_BASE_URL`, `BYTEPLUS_BASE_URL`, `FAL_BASE_URL`), or model overrides. Run multix with a controlled cwd, a scrubbed env, `MULTIX_DISABLE_HOME_ENV=1`, and explicit keys per call.
- **Partial key disclosure:** `multix check` prints each found key as first 6 + last 4 chars (`redact()` in `src/core/env-loader.ts`). pi-multix forwards that output to the model. Do not surface `check` output to agents.
- Gemini auth uses the `x-goog-api-key` header. Two code paths put the key in a URL query (`check` ping and an unused `listModels`); `HttpError` messages include the URL, but the ping path returns only the response snippet, so no full-key leak was found in reachable code.
- pi-multix passes the entire `process.env` to the child and returns raw stdout/stderr (including provider error bodies up to 500 chars) to the model. Its `multix_models` tool never accepts a key value by design, and writes `~/.multix/.env` at mode 600.
- No shell injection: both projects spawn via execa/`execFile` with argv arrays.

## 6. License and runtime

- Both MIT. Node >=20 for both; multix CI runs Node 20/22 on ubuntu-latest and windows-latest. No Bun support is declared or tested.
- External binaries: `ffmpeg` (media), ImageMagick 7+ invoked as `magick` (Debian bookworm's IM 6 has no `magick`; install IM 7 or use a newer base image, unverified here), `cwebp` (WebP finalize, from `webp` package), optional `codex` CLI for the OpenAI Codex driver.
- Docker: set `MULTIX_OUTPUT_DIR` to a mounted volume and a writable cwd; long jobs block the process (video defaults up to 8 to 15 minutes of polling).

## Options ranked

| Rank | Option | Effort | Risk | Fit |
|---|---|---|---|---|
| 1 | Own thin runner over `@mrgoonie/multix` CLI (pinned exact version), reusing pi-multix argv tables and runner pattern | Low-medium | 0.x churn; stdout parsing | Best: full control of env, cwd, matrix, cost, JSON results |
| 2 | Use pi-multix tools directly inside Pi | Lowest | Bundles multix 0.6.x; text-only results; key fragments reach model via `check` | Good for agent-only use, weak for an MCP registry |
| 3 | Import multix internals from `dist/` | Low | Breaks on refactor; maintainers advise against | Reject |

Adoption risk: single maintainer (mrgoonie), 37 stars, 5 open issues, repo 5 months old; pi-multix is 10 days old with 6 stars. Pin exact versions and add contract tests on `--help` output.

## Limitations

No provider call was executed (no keys used), so stdout formats for every command were not captured end to end. Bun and Alpine/musl behavior and ImageMagick 7 availability in Debian images were not verified.

## Unresolved questions

1. pi-multix 0.1.6 depends on `@mrgoonie/multix ^0.6.0`, which under 0.x caret semantics excludes 0.7.0, so it lacks `fal` and `update`; yet its docs cite Gemini 3.8 TTS (0.7.0). Is an upgrade planned, or should Motion MCP set `MULTIX_BIN`?
2. Would the multix maintainer accept a `--json` output mode and non-zero exit taxonomy upstream? That removes most stdout parsing.
3. Will Motion MCP run multix per tenant with per-request keys (needs env scrubbing), or with one shared key set?
4. Which transforms beyond optimize/split/batch does Motion MCP need, to scope its own ffmpeg layer?
