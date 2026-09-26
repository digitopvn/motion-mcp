# HyperFrames integration research for Motion MCP

Date: 2026-09-26. Source of truth: shallow clone of `heygen-com/hyperframes` at commit `473c862` (2026-09-26), its `docs/` tree, and `npm view`. Repo stats via `gh api`: 53.2k stars, 4.9k forks, 220 open issues, created 2026-03-10, Apache-2.0.

## Bottom line

Use the published packages as libraries for the parts they expose (`@hyperframes/core` to generate/parse, `@hyperframes/sdk` to edit, `@hyperframes/lint` to lint, `@hyperframes/producer` to render) and shell out to the `hyperframes` CLI with `--json` only for `check`, `snapshot`, and `keyframes`, which have no library export. Pin one exact version across all packages, because the project ships almost daily (432 published versions since 0.1.0 on 2026-03-23; 0.8.0 landed 2026-08-18, current 0.8.78). HeyGen already runs a hosted HyperFrames MCP (`https://mcp.heygen.com/mcp/hyperframes/`), so Motion MCP's differentiator has to be the Motion IR layer and local/self-hosted rendering, not "MCP for HyperFrames" itself.

## 1. Monorepo layout and npm packages

The repo is a Bun workspace (`package.json` scripts use `bun run --filter`). Top-level dirs: `packages/`, `skills/`, `registry/`, `docs/` (Mintlify), `examples/` (aws-lambda, gcp-cloud-run, k8s-jobs), `themes/`, plus `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/` agent-plugin manifests. All public packages are at 0.8.78 (published 2026-09-26).

| npm name | Dir | Role |
| --- | --- | --- |
| `hyperframes` | `packages/cli` (internal name `@hyperframes/cli`, which is NOT on npm) | CLI; bins `hyperframes`, `hyperframes-localize-fonts`; bin-only, no `exports`/`main` |
| `@hyperframes/core` | `packages/core` | Types, `generateHyperframesHtml`, `parseHtml`, compiler/bundler (`/compiler`), variables, browser runtime (`/runtime`) |
| `@hyperframes/parsers` | `packages/parsers` | Standalone composition parsers |
| `@hyperframes/lint` | `packages/lint` | Linter library; single rule engine used by CLI and render gate |
| `@hyperframes/sdk` | `packages/sdk` | Headless editing engine (query/mutate, JSON patches, undo, fs/memory adapters) |
| `@hyperframes/engine` | `packages/engine` | Low-level seek + capture (Puppeteer) + FFmpeg encode primitives |
| `@hyperframes/producer` | `packages/producer` | Full render pipeline (compile, capture, encode, audio mix), Hono render server, `/distributed` |
| `@hyperframes/player` | `packages/player` | `<hyperframes-player>` web component for playback |
| `@hyperframes/studio` | `packages/studio` | React 19 editor components and `StudioApp` |
| `@hyperframes/studio-server` | `packages/studio-server` | Hono backend for Studio (`createStudioApi(adapter)`) |
| `@hyperframes/shader-transitions` | `packages/shader-transitions` | WebGL shader transitions |
| `@hyperframes/aws-lambda`, `@hyperframes/gcp-cloud-run` | same | Distributed rendering adapters (CDK / Terraform) |

`packages/sdk-playground` is private.

## 2. CLI surface (`npx hyperframes <cmd>`; source `packages/cli/src/cli.ts`, reference `docs/packages/cli.mdx`)

Registered commands: init, add, catalog, media-use, play, present, publish, preview, render, lint, check, snapshot, keyframes, compare, grade-compare, beats, normalize-audio, info, compositions, timeline, history, benchmark, browser, doctor, upgrade, skills, docs, feedback, telemetry, events, capture, transcribe, tts, remove-background, auth, cloud, lambda, cloudrun, figma. `validate`, `inspect`, `layout` are deprecated aliases folded into `check`.

- Conventions: project dir is the first positional (defaults to cwd), except `add`, `transcribe`, `feedback`, `skills` which use `--dir`. Almost every command accepts `--json`, which wraps the payload with `_meta: {version, latestVersion, updateAvailable}` and makes no network call. Commands never prompt except `init` on a TTY (use `--non-interactive`) and `catalog --human-friendly`.
- `init <name> [--example|-e] [--resolution landscape|portrait|square|*-4k] [--video] [--audio] [--tailwind] [--non-interactive] [--skip-transcribe]`. It also installs agent skills unless `HYPERFRAMES_SKIP_SKILLS=1`.
- `preview [dir] [--port 3002] [--background|--foreground] [--status|--stop|--list|--kill-all|--force-new] [--json] [--selection|--context --json]`. Non-TTY callers get a managed background server that is reused per project; results include the Studio project URL.
- `lint [dir] [--verbose] [--json]` returns `{ok, errorCount, warningCount, infoCount, findings[], filesScanned}`. It is static HTML analysis with no browser.
- `check [dir] [--json] [--snapshots] [--samples 9] [--at 1.5,4] [--at-transitions] [--strict] [--no-contrast] [--tolerance 2] [--timeout 3000] [--caption-zone ...] [--frame-check]` runs lint, then one headless-Chrome seek sweep auditing runtime errors, layout (overflow/overlap/occlusion), contrast (WCAG AA) and optional `*.motion.json` sidecar assertions (`appearsBy`, `before`, `staysInFrame`, `keepsMoving`). JSON envelope: `{ok, lint, runtime, layout, motion, contrast, snapshots}`.
- `snapshot [dir] --at 2.9,10.4 | --frames 5 [-o dir] [--zoom sel|x,y,w,h] [--against ref.mp4] [--angle iso] [--describe false]` writes PNGs to `<project>/snapshots/`. `--describe` calls Gemini automatically when `GEMINI_API_KEY` is set; pass `--describe false` in a server context.
- `keyframes [dir] [--selector] [--runtime gsap|css|anime|all] [--json] [--shot out.png] [--samples 9] [--layout path|strip] [--from --to] [--ghost]` lists detected keyframes and renders onion-skin diagnostics.
- `render [dir] [-o out] [-c entry.html] [--format mp4|webm|mov|gif|png-sequence|hls] [--fps 1-240|30000/1001] [--quality draft|looks|delivery|standard|high] [--resolution preset] [--crf|--video-bitrate] [--workers 1-24] [--docker] [--gpu] [--variables json|--variables-file|--batch] [--strict|--strict-all|--strict-variables] [--resume] [--low-memory-mode] [--browser-timeout s] [--protocol-timeout ms] [--player-ready-timeout ms] [--json (batch only)]`. There is no frame-range flag on `render` (verified against the args list in `commands/render.ts`); frame/time selection exists only on `snapshot --at` and `keyframes --from/--to`. Server-mode `render` emits progress text, not JSON, except with `--batch --json`.
- `add <item|tag> [--dir] [--json] [--no-clipboard]` and `catalog [--type block|component] [--tag] [--query] [--on-device] [--json]` use the registry. `timeline --json` returns absolute clip timing across sub-compositions. `doctor --json` checks Node, FFmpeg, FFprobe, Chrome, Docker, and disk.
- Exit codes: 0 on success and 1 on failure. `lint --json` exits 1 when `errorCount > 0`; `check` exits 1 when `report.ok` is false (`checkExitCode` in `utils/checkPipeline.ts`), and `--strict` also fails on warnings. `doctor --json` always exits 0, so gate on `.ok`. `history undo` exits 2 on conflict. The lint command sets `process.exitCode` instead of calling `process.exit()` so piped JSON is not truncated on Windows.

## 3. Composition format

A project is a folder: `index.html` (root composition), `compositions/*.html` (scenes/blocks), `assets/`, `hyperframes.json` (registry URL and paths), `renders/`, and `snapshots/`. Agent planning files are optional (`BRIEF.md`, `STORYBOARD.md`, `SCRIPT.md`, `frame.md`). `frame.md` is a design spec whose frontmatter holds machine-readable brand tokens (hex, fonts) and whose prose holds intent. Only the skills read it; the renderer does not (`docs/prompting/design-systems.mdx`).

The rules come from `docs/concepts/compositions.mdx`, `data-attributes.mdx`, and `reference/html-schema.mdx`. The root element carries `data-composition-id`, `data-start="0"`, `data-width`, `data-height`, and usually `data-duration`. Each timed element needs `id`, `class="clip"`, `data-start` (seconds, or relative such as `intro + 0.5`), and `data-duration`. `data-track-index` only sets the Studio lane; paint order comes from CSS `z-index`. Motion lives in a paused GSAP timeline registered as `window.__timelines["<composition-id>"] = tl`. Scripts must never play, seek, or show/hide clips themselves. A sub-composition is a host `<div data-composition-id="x" data-composition-src="compositions/x.html" data-start data-duration>`, and the child file wraps its content in `<template>`, uses local time, and registers its own timeline. Paths resolve from the project root. Variables are declared through `data-composition-variables` (types: string, number, color, boolean, enum, font, image), passed through `data-variable-values`, and read through `window.__hyperframes.getVariables()`. Determinism rules: no `Date.now`/rAF, no unseeded `Math.random`, and no mid-render fetches.

The following is the minimal valid composition, adapted from `packages/cli/src/templates/blank/index.html`:

```html
<!doctype html>
<html lang="en"><head><meta charset="UTF-8" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#0a0a0a}
#title{color:#f4f4f5;font:600 72px Inter,sans-serif}</style></head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="10"
       data-width="1920" data-height="1080">
    <h1 id="title" class="clip" data-start="0" data-duration="10" data-track-index="0">Title</h1>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#title", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6 }, 0);
    window.__timelines["main"] = tl;
  </script>
</body></html>
```

## 4. Rendering pipeline

The renderer bundles the project, serves it, and drives Chrome through `puppeteer-core` ^25 and `@puppeteer/browsers`. `hyperframes browser ensure` downloads `chrome-headless-shell` into a cache. For each frame it computes `t = frame/fps` with integer math, seeks every adapter (GSAP, CSS, Anime.js, Lottie, Three.js), and captures the frame. Capture uses `HeadlessExperimental.beginFrame` only on Linux with the bundled headless shell; on macOS and Windows it falls back to screenshot capture, and multi-worker renders spill raw RGBA to disk (about 25 GB per minute at 1080p30) unless `HF_CAPTURE_PARALLEL_STREAM=true` is set. FFmpeg and FFprobe must be on PATH to encode and mux audio. `--docker` builds a local image (`hyperframes-renderer*` from `packages/cli/src/docker/Dockerfile.render`: `node:22-bookworm-slim`, ffmpeg, and chrome-headless-shell) that pins Chrome, fonts, and FFmpeg for pixel-exact output. No prebuilt public image was found.

Remote options:
- `hyperframes cloud render`: the project is zipped (200 MB cap), then submitted to HeyGen `POST /v3/hyperframes/renders` and polled. It supports `--no-wait`, `--callback-url`, and `--idempotency-key`, needs `hyperframes auth login` or `HEYGEN_API_KEY`, is billed in credits, and allows mp4/webm/mov at 1080p or 4k.
- `lambda` (AWS) and `cloudrun` (GCP) run self-hosted, chunked distributed renders.

Render speed depends on the machine and the composition. Workers are separate Chrome processes of about 256 MB each, and low-memory mode switches on automatically at 8 GB of RAM or less. The only first-party figure is 25.0 s against 9.8 s for 300 frames at 1080p, where the difference came from one CSS change (`docs/guides/performance.mdx`). `hyperframes benchmark` measures the local machine. Transparent WebM (VP9) is noted as CPU-heavy.

## 5. Programmatic Node API

Yes, the packages can be used without shelling out, for most stages. All of them are ESM.
- Render: `import { createRenderJob, executeRenderJob } from "@hyperframes/producer"`. `createRenderJob({fps, quality: "draft"|"standard"|"high", format, entryFile, workers, crf, hdrMode, strictness, ...})`, then `await executeRenderJob(job, projectDir, outPath, onProgress, abortSignal)`. It throws `RenderCancelledError`. `startServer({port})` is also available, and `@hyperframes/producer/distributed` exposes `plan`, `renderChunk`, and `assemble`.
- Lint: `import { lintProject, lintHyperframeHtml, shouldBlockRender } from "@hyperframes/lint"`.
- Generate and parse: `generateHyperframesHtml(elements, durationSec, {compositionId, resolution, animations, styles})` and `extractCompositionMetadata(html)` from `@hyperframes/core`. The docs warn that code-bearing inputs (`__raw:` animations, styles) must come from trusted authors.
- Edit: `openComposition(html)` from `@hyperframes/sdk` provides `find`, `setText`, `setStyle`, timing, variable, and animation edits, then `serialize()`. `@hyperframes/sdk/adapters/fs` persists edits with version history.
- Gaps: `check`, `snapshot`, `keyframes`, and `timeline` have no library export (their logic lives in `packages/cli/src/utils/checkPipeline.ts` and friends), so use `npx hyperframes <cmd> --json`. For raw frames, `@hyperframes/engine` offers `createCaptureSession` and `captureFrameToBuffer`, but that is a low-level contract.

## 6. Studio editor

Studio is `@hyperframes/studio`, which requires React 19, React DOM 19, and Zustand 4 or 5. It exports `StudioApp` (the full app) plus building blocks (`EditorShell`, `NLEPreview`, `Timeline`, `PropertyPanel`, `Player`, and hooks). The docs warn that these building blocks are not a drop-in embedded editor. The backend is `@hyperframes/studio-server`, where `createStudioApi(adapter: StudioApiAdapter)` returns a Hono app that you mount at `/api`. The adapter supplies project resolution, bundling (it must pass options through to `bundleToSingleHtml`), linting, render jobs, and optionally thumbnails and registry installs. Persistence works through file writes: the editor sends patches to the Studio API, the server writes them back into the project's HTML, and external file changes hot-reload the preview.

Embedding options, ranked:
1. Run `hyperframes preview --background --json` and embed its Studio URL in an iframe. This is the simplest and is officially supported.
2. Host `StudioApp` together with `createStudioApi` in your own app. This is heavier, and the adapter interface changes between versions.

For playback only, use `<hyperframes-player src=...>`. Studio also registers WebMCP tools (`studio_look`, `studio_inspect`, `studio_set_style`, `studio_frame`) for in-browser agents, but browser support is limited to Origin Trial or experimental builds.

## 7. Skills, registry, MCP

The repo ships 21 skills in `skills/`, listed in `skills-manifest.json`. They include `hyperframes`, `hyperframes-core`, `-cli`, `-animation`, `-keyframes`, `-creative`, `-audio`, `-registry`, and `-studio`, plus workflow skills: general-video, motion-graphics, product-launch-video, pr-to-video, slideshow, music-to-video, faceless-explainer, embedded-captions, talking-head-recut, remotion-to-hyperframes, figma, and media-use. Install them with `npx skills add heygen-com/hyperframes [--skill x | --all]` or `npx hyperframes skills update`. The registry (`registry/registry.json`) holds 164 blocks (sub-composition scenes), 223 components (effects/snippets), and 8 examples. Items are installed with `hyperframes add` and may declare `registryDependencies` and `minCliVersion`. Catalog search can run offline (`--on-device` downloads a 33 MB bge-small model).

For MCP, there is no MCP server package in the repo (no `@modelcontextprotocol` dependency anywhere). What exists is HeyGen's hosted, OAuth-only MCP (beta, cloud rendering, billed; `docs/guides/mcp.mdx`) and Studio's WebMCP tools.

## 8. License, Node, Windows

The license is Apache-2.0, confirmed by `LICENSE` and GitHub. The CLI, engine, producer, and cloud adapters declare `engines.node >= 22`. Core, lint, and sdk declare no engine but are built alongside the others. Telemetry is on by default: it records command names, the name of the coding agent, and system shape. Disable it with `HYPERFRAMES_NO_TELEMETRY=1`, and set `HYPERFRAMES_NO_UPDATE_CHECK=1` for servers.

Windows works, with caveats:
- Capture is screenshot-based on Windows, not BeginFrame.
- Open issues: #4060 (the disk-headroom gate rejects ordinary renders, estimating about 16 GB per minute), #4058 (transient `spawn EBUSY` on ffmpeg fails the whole render with no retry), and #3476 (console windows flash).
- Several `windowsHide` fixes landed between 2026-08-21 and 2026-09-17 (#3379, #3430, #3500, #4028).
- For deterministic, production-grade output, render in Linux/Docker.

## Recommendation (ranked)

1. **Hybrid library + CLI.** Generate HTML from the Motion IR directly, following the format in section 3 and reusing core types. Lint in-process with `@hyperframes/lint`. Run `hyperframes check/snapshot --json` as a subprocess. Render with `@hyperframes/producer` in a Linux container. This has the best control and the lowest parsing cost; the risk is fast API churn, mitigated by exact version pins and contract tests.
2. **CLI-only.** Shell out to every command with `--json`. This is the simplest and most stable surface (`_meta` versioning), but it adds process overhead and renders give progress text rather than JSON.
3. **HeyGen `cloud render` as an optional backend** when users lack Chrome and FFmpeg. It needs HeyGen credentials and credits and has a 200 MB zip cap.

## Limitations

The following were not verified: actual render times on this machine, whether `@hyperframes/lint` and `@hyperframes/sdk` work under Node below 22, the exact `StudioApiAdapter` TypeScript shape, and the full JSON schemas of the `check` and `snapshot` outputs. The local Git Bash shows an `fnm env` warning; `npm` still worked.

## Unresolved questions

1. Should Motion IR target `@hyperframes/core`'s `TimelineElement` model (via `generateHyperframesHtml`), or emit raw HTML plus GSAP for full expressiveness? Core's parse/generate is documented as lossy for inline formatting.
2. Is a subprocess acceptable for `check` and `snapshot`, or should we ask upstream to export `checkPipeline`?
3. Which render host is the target (local Windows dev, a Linux container, or HeyGen cloud)? The answer decides the determinism guarantees and the Windows workarounds.
4. Is default-on telemetry acceptable inside a product server, or must it be disabled everywhere?
