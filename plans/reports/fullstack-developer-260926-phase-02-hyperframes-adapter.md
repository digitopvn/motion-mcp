# Phase 02 — HyperFrames adapter: implementation report

Status: DONE_WITH_CONCERNS. The only concern is a lint failure in a file owned by another phase.

## What was built

**The compiler**, `packages/hyperframes-adapter/src/compile.ts`, turns a MotionIR into a HyperFrames project:
- `index.html` is the root composition `main`. It has one host `div` per scene carrying `data-composition-src`, `data-start`, `data-duration` and `data-track-index`.
- Each scene is written to `compositions/<sceneId>.html` as a `<template>` sub-composition with a paused GSAP timeline, registered in `window.__timelines`. The timeline ends with `tl.set({}, {}, duration)`.
- The project also contains `hyperframes.json`, `motion-ir.json`, a vendored `assets/vendor/gsap.min.js` (gsap 3.14.2, so there is no CDN fetch) and bundled font files.
- Output is byte-deterministic, and a test enforces this.

**Tokens and layout**
- Easing tokens map exactly as the phase file specifies.
- Size tokens are px values at 1080, scaled by `min(w,h)/1080`.
- Color tokens become `--c-*` CSS variables on each scene stage. Missing muted, surface, accent-2 and line colors are derived.
- Layout templates map to flex or grid: center, stack, statement, lower-third, full-bleed, split and grid.
- Code blocks shrink their font so the longest line fits the layout slot, because code never wraps.

**Motion**
- Every primitive is implemented in `motion.ts`: fade-in, fade-up, slide-in, scale-in, mask-reveal, type-on, draw, count-up, stagger-in, emphasize, hold and exit.
- `immediateRender:false` is set on every tween after the first one on a given target.

**Beat timing** (`timing.ts`)
- Beats can be a number, `{after}` or `{with}`.
- References are read in choreography order. For example, "latency count-up → note after latency → latency emphasize after note" is valid and is not treated as a cycle.
- Forward references work. A genuine cycle throws a VALIDATION error.

**Transitions**
- Supported: cut, fade, slide-left, slide-up, wipe, mask and scale-through.
- match-cut degrades to cut.
- Transitions animate each scene's stage wrapper, and their combined length is capped at 80% of the scene.

**Determinism and text safety**
- The generated HTML never uses Date, requestAnimationFrame, Math.random, `repeat:-1`, CSS animations or transitions, or timers. Tests assert this.
- All user text is HTML-escaped.

**Fonts** (the full rationale is in the comment at the top of `fonts.ts`)
- Brand families resolve to the exact-pinned `@fontsource/*` packages.
- The latin, latin-ext and vietnamese woff2 files are copied into `assets/fonts/` and declared with `@font-face` in every composition. Because the families are already declared, the producer does not inject its own, and the compiler embeds the files as data URIs.
- Unknown families fall back to Inter or JetBrains Mono, with a warning.

**Lint** (`lint.ts`)
- Runs `@hyperframes/lint` `lintProject` in-process and returns `QaIssue[]`.
- Category is always `lint_error`; severity is error→error, warning→warn, anything else→info.
- `sceneId` comes from `compositions/<id>.html`.

**Check, snapshot and keyframes** (`cli.ts`, `inspect.ts`, `qa.ts`)
- These run the pinned `hyperframes@0.8.78` bin through `process.execPath`, `runCommand` and `scrubbedEnv`, with the three `HYPERFRAMES_*` environment flags. Snapshot also gets `--describe false` and `--no-end`.
- Check findings from the runtime, layout, motion and contrast sections become `QaIssue[]`:
  - Categories: overflow, collision, text_clipping, safe_area, low_contrast, runtime_error, timing_mismatch and broken_image.
  - `sceneId` comes from the source file, then the selector prefix `#m-<id>__`, then time against the scene start offsets.
- Snapshot frames are read back from disk, not parsed from console output.

**Contact sheet**
- Takes N frames per scene at mid-hold points. The hold window starts after the in-transition and all entrance beats, and ends before the out-transition or the first exit.
- The frames are tiled into one PNG with `tileImages`.

**Render** (`render.ts`)
- Uses `@hyperframes/producer` `createRenderJob`/`executeRenderJob` and falls back to the CLI `render` subprocess if the producer import fails. `forceCli` forces the fallback.
- Presets:
  - `preview`: draft quality at up to 15 fps, downscaled to 540p in the finishing encode (the producer can only upscale).
  - `final`: standard quality at native size and fps, CRF 18.
  - `final-4k`: 2× device scale factor. It works for 1920×1080, 1080×1920 and 1080×1080 compositions; other sizes throw a clear VALIDATION error.
- Supports a progress callback (0..1) and an AbortSignal (a cancelled render throws `CANCELLED`).
- Every render then goes through `finishMp4`.
- The producer prints progress to stdout with `console.log`, which would corrupt stdio MCP or `--json` output. While a render runs, that output is redirected to the stderr logger (reference-counted).

**Doctor** (`doctor.ts`)
- Checks Node ≥22, the hyperframes CLI version, Chrome via `browser path` (running `browser ensure` if it is missing) and FFmpeg/FFprobe versions.
- Returns a structured report.

**Media** (`packages/media/src/ffmpeg.ts`)
- Provides `probe`, `finishMp4`, `extractFrame`, `tileImages`, `detectBlack` and `ffmpegVersions`, plus the parsers.
- Binaries are spawned with an argv array and a scrubbed environment.

**Fixtures**
- Four new golden specs: technical-explainer, kinetic-typography, data-visualization and architecture-diagram.
- Between them they use every layout, most primitives, all the required transitions, and fonts from six families.
- All four compile, lint clean and check clean, and I inspected their contact sheets by eye.

## Exported API (`@motion-mcp/hyperframes-adapter`)

- **Adapter:** `createHyperframesAdapter()` returns a `HyperframesAdapter`. It implements `MotionRendererAdapter`: `compile`, `lint`, `check`, `snapshot`, `contactSheet`, `render` and `doctor`.
- **Compile:** `compileProject(ir, outDir, { assets? })` returns `{ projectDir, files, compositionId, duration, sceneStarts, warnings }`.
- **Lint and check:** `lintCompiledProject(dir)` and `checkProject(dir)` both return `CheckReport { ok, issues: QaIssue[], counts }`.
- **Snapshots:** `snapshotProject(dir, { at, outDir? })` returns `SnapshotFrame[]`.
- **Contact sheet:** `contactSheet(dir, { framesPerScene?, outPath?, tileWidth? })` returns `{ path, frames, columns }`.
- **Keyframes:** `keyframesProject(dir, { selector? })`.
- **Render:** `renderProject(dir, { preset, outputPath, onProgress?, signal?, fps?, workers?, logger?, forceCli? })` returns `{ outputPath, durationMs, probe, preset, renderer, fps, warnings }`.
- **Doctor:** `doctor({ ensureBrowser? })` returns `DoctorReport`.
- **Helpers:** `planPreset`, `holdWindow`, `resolveBeats`, `normalizeCheckReport`, `inferSceneId`, `readProjectIr`, `readSceneSpans`, `GSAP_EASE`, `gsapEase`, `hyperframesBin`, `runHyperframes`, `HYPERFRAMES_ENV`, `ROOT_COMPOSITION_ID` and `GSAP_ASSET`.

## Test results

**`pnpm test`: 21 files and 201 tests pass.** That total includes every workspace package. This phase's tests are:
- `test/compile.test.ts`, 19 tests:
  - For all five goldens: structure (root attributes, one composition per scene, host starts and durations, registered timelines, `tl.set` end, `@font-face`, no forbidden APIs) and byte-determinism.
  - HTML escaping, and rejection of an invalid IR or an unsafe asset path.
  - Beat timing, including order-aware references, forward references, cycles and clamping.
  - The easing map, the code tokenizer and the metric formatter.
- `test/qa.test.ts`: lint reports zero errors on all five goldens; a missing project gives NOT_FOUND; unit tests for check normalization and scene inference; and a real `check --json` run on technical-explainer, validated against the QaIssue schema.
- `test/render.test.ts`:
  - Unit tests for presets and hold windows.
  - A real render of a preview MP4 from a 2-scene, 3-second IR. `probe` confirms 960×540, h264, yuv420p, no audio and a duration of about 3 s; the test also checks that progress only increases and ends at 1.
  - A contact sheet with 2 frames per scene.
  - A render with an already-aborted signal throws `CANCELLED`.
  - This suite is skipped only when doctor reports Chrome or FFmpeg missing. Both are present here, so it ran.
- `packages/media/test/ffmpeg.test.ts`: 9 tests.

**Other checks**
- `pnpm typecheck`: clean.
- `pnpm lint`: my files are clean. It fails on one foreign file (see open issues).

## Render timings (this machine, RTX 5060 Ti host, producer auto workers = 6)

| Input | Preset | Output | Wall time (incl. finish encode) |
|---|---|---|---|
| product-launch, 30 s | preview (draft, 15 fps, 540p) | 960×540, 30.0 s, 98 KB | 30.1 s |
| product-launch, 30 s | final (standard, 30 fps, 1080p) | 1920×1080, 30.0 s, 506 KB | 36.8 s |
| 2-scene 3 s IR | final-4k | 3840×2160, 3.0 s | 28.3 s |

Preview is only slightly faster than final. Capture time is dominated by browser session start-up and seeking rather than pixel count, and the producer's static-frame reuse already skips most frames on held shots.

## Open issues

1. `pnpm lint` fails on `packages/pipeline/package.json`. That file belongs to another phase: its `exports` object is on one line and the formatter wants it expanded. I did not touch it.
2. The producer writes font-embedding `[INFO]` lines to stderr no matter which logger is passed. This is harmless for stdout protocols.
3. `final-4k` uses a device-scale-factor upscale, so it only works for compositions whose size is exactly half a 4K canvas. Other sizes are rejected with a clear error.
4. `hyperframes check` runs its own lint pass. The adapter ignores that section to avoid duplicating the in-process lint.
