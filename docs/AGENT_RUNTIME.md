# Agent Runtime (Pi)

Pi is the scene-implementation and patch worker. It is not the job scheduler:
`packages/pipeline` owns job state, retries and budgets, and it calls Pi one
scene at a time through the `SceneWorker` interface. All Pi calls go through
`packages/pi-runtime`, whose source (`pi-worker.ts`, `path-guard.ts`,
`prompt-builder.ts`, `trace-mapper.ts`) is the authority for the exact session
options. The decision record is
[ADR 0006](decisions/0006-pi-embedded-runtime.md).

## Two build tiers

| Tier | When it runs | Cost | Role |
|---|---|---|---|
| Deterministic compiler (`hyperframes-adapter`) | The default for every scene. It maps IR elements and beats to HyperFrames HTML using typed motion primitives. | No model spend. | The reliability floor and the CI path. |
| Pi worker | Scenes chosen by `IMPLEMENTATION_MODE` (`auto`: scenes with `implementation: "custom"`; `pi`: every scene; `deterministic`: none), mechanical fixes that no IR patch can express, and patch changes the IR cannot represent. | Cheap coder tokens. | Widens the vocabulary beyond the compiler's primitives. |

The worker exists only when `OPENROUTER_API_KEY` is set, `IMPLEMENTATION_MODE`
is not `deterministic`, and Pi initializes. If initialization fails, for
example because `CODER_MODEL` is missing from Pi's bundled model catalog, the
server logs `pi.unavailable` and every scene uses the compiler.

When a worker-built scene fails lint or check, the pipeline reverts that scene
to the compiler's output before classifying issues, and reports the reversion
in the job warnings. This keeps the video renderable, and it stops worker
mistakes from being escalated as creative problems.

## Session configuration

The runtime embeds Pi in-process through the SDK
(`@earendil-works/pi-coding-agent`, pinned exactly) using
`createAgentSession`:

| Setting | Choice | Reason |
|---|---|---|
| `cwd` | The version's compiled project directory | Scopes default tool paths. It is not a sandbox (see Isolation). |
| Session and settings | In memory, compaction off, provider retry on (2 retries) | Nothing persists between jobs, and scene tasks are short. |
| Thinking level | `off` | Keeps scene building cheap. |
| Resources | A private temporary agent directory; no extensions, skills, prompt templates, themes or context files are discovered; a short custom system prompt | The user's and the project's Pi setup never leak into a worker. |
| Model catalog | Pi's bundled catalog, with no network refresh; the key is set through the runtime's API-key setter | The key never enters a prompt or a file. |
| Budgets | A turn limit, a wall-clock timeout and the job's abort signal | A runaway session fails fast with `budget_exceeded`, `timeout` or `cancelled`. |

## Tool allow-list

- **Built-in tools:** `read`, `write`, `edit`, `ls`, `grep` and `find`.
  `bash` is available only through an explicit `allowBash` option, which the
  pipeline never sets, because a shell bypasses the path guard. `powershell` is
  never granted.
- **Custom tool:** `submit_scene` (below).
- **Planned:** engine-backed custom tools such as `motion_read_spec`,
  `motion_snapshot`, `motion_asset_generate` and an allow-listed `motion_ffmpeg`.
  Until they exist, the scene IR and context are supplied in the task prompt.

## Submit tool

A session ends when Pi calls `submit_scene`. The tool checks that the scene
file exists and is not empty, then returns `terminate: true`, so the run ends
without paying for another model turn. A wrong file is rejected and the model is
asked to retry. A session that settles without a submission is a failed,
retryable attempt.

## Path guard

An inline extension hooks Pi's `tool_call` event and blocks, with a reason:

- any path outside the project directory, after Pi's own path normalization and
  after resolving symlinks of the nearest existing ancestor;
- `find` and `grep` patterns that escape the project;
- writes to the protected `motion-ir.json` and `hyperframes.json`, and reads of
  them unless the policy allows protected reads;
- writes to anything except the scene's own `compositions/<sceneId>.html`;
- unknown tools, and `bash` or `powershell` unless explicitly allowed.

The guard is a correctness aid, not the security boundary. Isolation is the
boundary.

## Task prompt

`prompt-builder.ts` builds each build or patch task from the scene IR, a
compact video context (format, brand, motion language), the composition
contract, and domain-pack snippets resolved for the scene, trimmed to a fixed
token budget. Patch tasks add the patch instructions and the scene's QA issues,
errors first. Whole style profiles are never injected
([ADR 0012](decisions/0012-domain-pack-lift-and-wrap.md)).

## Model configuration

`CODER_MODEL` (default `deepseek/deepseek-v4-flash`, an OpenRouter slug) must
exist in Pi's bundled catalog and support tool calls. The design ranks these
alternatives by price and capability flags only: `z-ai/glm-5.3-flash`, then
`qwen/qwen3.8-flash`, then `moonshotai/kimi-k2.7-code` as a quality fallback.
They must be benchmarked on real HyperFrames scene tasks before any of them
replaces the default. `typesafe/jev-router` is not a coder model.

## Events to traces

`trace-mapper.ts` maps session events onto the job trace (see
[OBSERVABILITY.md](OBSERVABILITY.md)): one span per scene task, one model call
per assistant message with its usage and cost, and tool calls, tool errors,
blocked calls, turns, retries and the stop reason as `pi.*` attributes. Session
totals are copied onto the span when the session ends.

## Isolation

- Pi's `cwd` is not a sandbox. Its file tools can reach any path the process
  can, which is why the path guard exists and why production runs in a
  container.
- The production image runs as the non-root `node` user, and its only
  persistent writable volume is `DATA_DIR`. Per-job container or mount
  isolation, so that a worker can write only to its own job directory, is
  **planned**.
- Workers have no shell tool, and no shell is ever exposed publicly.
- Provider credentials never appear in prompts, tool results or task text (see
  [SECURITY.md](SECURITY.md)).
- HTML produced by Pi is untrusted input. It is linted, checked and rendered
  only by the pipeline, and it is served back to clients as non-executable
  content.
