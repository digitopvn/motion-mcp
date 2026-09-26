# Agent Runtime (Pi)

Pi is the scene-implementation and patch worker. It is not the job scheduler:
`packages/pipeline` owns job state, retries and budgets, and it calls Pi one
scene at a time. All Pi calls go through `packages/pi-runtime`, which is
planned. Once that package exists, its source is the authority for the exact
session options. The decision record is
[ADR 0006](decisions/0006-pi-embedded-runtime.md).

## Two build tiers

| Tier | When it runs | Cost | Role |
|---|---|---|---|
| Deterministic compiler (`hyperframes-adapter`) | This is the default for every scene. It maps IR elements and beats to HyperFrames HTML using typed motion primitives. | No model spend. | The reliability floor and the CI path. |
| Pi worker | Runs when `scene.needsCustomCode` is true, or when a `ScenePatch` change cannot be applied deterministically. | Cheap coder tokens. | Widens the vocabulary beyond the compiler's primitives. |

When a Pi build fails its gates within its retry budget, the pipeline falls
back to compiling that scene deterministically. This keeps the video
renderable, and the fallback is recorded on the trace.

## Session configuration

The runtime embeds Pi in-process through the SDK
(`@earendil-works/pi-coding-agent`, pinned exactly to 0.87.1) using
`createAgentSession`. Each session uses these settings:

| Setting | Value | Reason |
|---|---|---|
| `cwd` | The job's working directory for the project | Scopes resource discovery and default tool paths. It is not a sandbox (see Isolation). |
| `sessionManager` | `SessionManager.inMemory(cwd)` | Nothing persists between jobs. |
| `settingsManager` | In memory, with compaction off and provider retry on (`maxRetries: 2`) | Scene tasks are short, so compaction would only add cost. |
| `thinkingLevel` | `off` | Keeps scene-building cheap. |
| `resourceLoader` | `DefaultResourceLoader` with an explicit skills override | Skills are injected, never discovered. |
| Project trust | Untrusted | The project-local `.pi/` directory is never loaded. |

## Tool allow-list

- **Built-in tools:** `read`, `write`, `edit`, `ls`, `grep` and `find`. The
  `bash` and `powershell` tools are excluded, because a shell bypasses the path
  guard.
- **Custom tools:** these are defined with TypeBox, which is what Pi requires,
  and they call engine functions directly rather than a shell:
  - `motion_read_spec` and `motion_scene_build`
  - `motion_scene_patch`
  - `motion_snapshot`, `motion_render_preview` and `motion_report`
- **Media tools:** `motion_asset_search`, `motion_asset_generate`,
  `motion_audio_mix` and `motion_ffmpeg` are granted only to jobs whose route
  includes the media worker.

The full list of internal tools is in [MCP_API.md](MCP_API.md#internal-worker-tools).

## Submit tool

A session ends when Pi calls `submit_scene`. Its parameters are
`{ files: string[], notes: string }`, and it returns `terminate: true`, so the
run ends without paying for another model turn. The runtime treats the
`details` of the submit call as the structured result. A session that settles
without calling submit is a failed attempt.

## Path guard

An extension hooks `tool_call` and blocks any `read`, `write`, `edit`, `ls`,
`grep` or `find` call whose resolved path is outside the job's working
directory. It returns `{ block: true, reason }`. Symlinks are resolved before
the check. The guard is a correctness aid, not the security boundary. Isolation
is the boundary.

## Skills injection

The runtime sets the skill set explicitly through the skills override. Each
session gets three things:

- a HyperFrames authoring skill covering the composition contract, determinism
  rules and renderer limits;
- the domain-pack slices resolved for this scene (see
  [ADR 0012](decisions/0012-domain-pack-lift-and-wrap.md));
- the invariant rules that are always injected.

Pi places only each skill's name, description and path into the system prompt,
and the model reads the full skill on demand. Whole style profiles are never
injected.

## Model configuration

| Key | Default | Requirement |
|---|---|---|
| `CODER_MODEL` | `deepseek/deepseek-v4-flash` (OpenRouter slug) | Must advertise `tools` on OpenRouter. The check runs at startup, and startup fails fast if it does not pass. |

The OpenRouter key is supplied through the Pi model runtime's API-key setter,
never through a prompt. The design ranks these alternatives by price and
capability flags only: `z-ai/glm-5.3-flash`, then `qwen/qwen3.8-flash`, then
`moonshotai/kimi-k2.7-code` as a quality fallback. They must be benchmarked on
real HyperFrames scene tasks before any of them replaces the default.
`typesafe/jev-router` is not a coder model.

## Retries

| Layer | Behavior |
|---|---|
| Provider | Pi retries transient provider errors, up to 2 times. |
| Gate | After a submit, the pipeline runs lint and check on the scene. If they fail, the findings go back to Pi as a patch task. |
| Fallback | If the scene still fails after its patch attempts, it is built by the deterministic compiler. |
| Budget | Every attempt is checked against the job's remaining credits before it starts. |

## Events to traces

The runtime subscribes to session events and maps them onto the job trace (see
[OBSERVABILITY.md](OBSERVABILITY.md)).

| Pi event | Trace effect |
|---|---|
| Session start | Opens a `pi.session` span (scene id, model, tier). |
| `tool_execution_start` / `tool_execution_end` | Opens and closes a child `pi.tool` span carrying the tool name, `isError` and duration. Arguments are redacted. |
| `message_end` (assistant) | Records a `model_call` with tokens in, tokens out, cache reads and cost from the message usage. |
| Session stats at the end | Totals are written on the `pi.session` span, and the session is disposed. |

## Isolation

- Pi's `cwd` is not a sandbox. Its tools can reach any path the process can.
- Pi sessions run inside the worker container. The only writable mount is the
  job's working directory, and the process runs as a non-root user.
- Workers have no shell tool, and no shell is ever exposed publicly.
- The worker environment contains only the variables the worker needs. Provider
  credentials never appear in prompts, tool results or skill text (see
  [SECURITY.md](SECURITY.md)).
- HTML produced by Pi is untrusted input. It is linted, checked and rendered
  only inside the container.
