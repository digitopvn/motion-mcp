# 0006. Pi embedded in-process as the scene worker

## Status

Accepted.

## Context

Scenes that need bespoke code, and patches that cannot be applied
deterministically, need a coding agent that runs on a cheap model. Pi
(`@earendil-works/pi-coding-agent`) offers several things that fit:

- an in-process SDK (`createAgentSession`);
- a tool allow-list;
- custom TypeBox tools that can end a run with `terminate: true`;
- extension hooks that can block tool calls;
- usage and cost reported on each message.

Pi moves fast: its npm scope was renamed from `@mariozechner` to
`@earendil-works` within months. Its `cwd` is not a sandbox.

## Decision

- Embed Pi in-process through the SDK, pinned exactly to **0.87.1**. Only
  `packages/pi-runtime` imports Pi.
- Each scene gets an in-memory session. Built-in tools are restricted to file
  tools, and `bash` is excluded. Engine operations are exposed as custom
  tools.
- The run ends when Pi calls a `submit_scene` tool with `terminate: true`, and
  the arguments of that call are the structured result.
- A `tool_call` path-guard extension blocks paths outside the job directory.
  Sessions run inside a container as a non-root user, and that container is the
  security boundary.
- The deterministic compiler is the reliability floor. Every scene can be built
  without Pi, and a failed Pi scene falls back to the compiler.
- `CODER_MODEL` defaults to `deepseek/deepseek-v4-flash` and is configurable.

The details are in [AGENT_RUNTIME.md](../AGENT_RUNTIME.md).

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Pi over RPC (`--mode rpc`) or the JSON CLI | Adds process management and parsing. Process isolation is achieved at the container level instead. |
| Our own agent loop | Rebuilds tools, retries and cost accounting that Pi already has. |
| Pi as the job scheduler | Job state, budgets and retries belong to the pipeline, which must survive the failure of any one worker. |
| Allowing `bash` | A shell bypasses the path guard. |

## Reason

The SDK gives typed events and structured results with the least glue.
Because the compiler floor exists, Pi improves quality without being
load-bearing for reliability.

## Trade-offs

- In-process embedding shares memory with the pipeline.
- A crash in Pi affects the worker process, and this is mitigated by per-scene
  sessions and container restarts.
- Leaving out `bash` limits what Pi can verify on its own. Verification is done
  by the custom tools instead.

## Migration strategy

Upgrading Pi changes only `pi-runtime`, and that package's tests use a mocked
model. If stronger isolation is needed, the same wrapper interface can drive Pi
through RPC in a separate container per job.
