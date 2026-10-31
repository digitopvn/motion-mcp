# 0013. Claude roles on the workspace's own Anthropic key, SDK-first

## Status

Accepted.

## Context

Workspaces want to run the creative director, the critic and the scene worker
on Claude and pay Anthropic directly with their own key (BYOK), instead of
spending platform credits on the server's OpenRouter key. Three constraints
shape the design:

- **Terms.** Anthropic does not permit consumer subscription credentials
  (Claude Pro/Max sign-in) to power third-party hosted products. Only an
  Anthropic API key is a compliant credential for a hosted service.
- **Who pays.** The official SDKs read `ANTHROPIC_API_KEY`,
  `ANTHROPIC_BASE_URL` and `~/.claude` from the environment by default. On a
  shared server that would let one workspace's job spend another key, or the
  operator's.
- **Isolation.** The Claude Agent SDK drives the Claude Code binary, an agent
  with file tools that runs as a separate process. Its `cwd` is not a sandbox,
  the same problem Pi has ([ADR 0006](0006-pi-embedded-runtime.md)).

## Decision

- **SDK-first.** The Director and Critic call the Messages API through the
  official `@anthropic-ai/sdk` (pinned to **0.124.0**) in `packages/llm`. The
  scene worker uses `query()` from `@anthropic-ai/claude-agent-sdk` (pinned to
  **0.3.303**); only `packages/claude-agent-runtime` imports it.
- **API key only.** The workspace stores an Anthropic API key from the
  dashboard. Subscription OAuth is shown as `blocked_by_policy`, with no login
  button. It is revisited only with Anthropic's written approval.
- **Role abstraction.** Each role picks a backend per workspace:
  - director and critic: `openrouter` (server default) or `anthropic-api`;
  - scene worker: `pi` (server default) or `claude-agent-sdk`;
  - fallback when the workspace key is missing or rejected: `none` (default)
    fails the role clearly, and the scene worker falls back to the
    deterministic compiler; `server` uses the server defaults and bills
    credits. Keys are never swapped silently.
- **Pinned per job.** The selection is snapshotted into the job at enqueue.
  Changing settings later never changes who pays for a queued or running job.
  Only the choice is stored on the job; the key is read from the sealed store
  when the job runs.
- **No ambient credentials.** There is no server-level Anthropic key. Clients
  receive the key explicitly (`authToken: null`, pinned base URL). The agent
  process gets a scrubbed environment, a private home with its own
  `CLAUDE_CONFIG_DIR`, and `settingSources: []`, so the server's
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `~/.claude` are never read.
- **Sandbox.** The agent runs under bubblewrap with `prlimit` resource limits,
  in its own process group that is killed as a whole on abort or timeout. When
  the sandbox probe fails, the Claude worker is reported unavailable.
- **Billing.** `creative_direction` and `creative_critique` are waived only
  when the workspace's own key paid for the call. Orchestration and renders are
  always charged. The SDK's reported cost is a client-side estimate; the
  workspace's Anthropic invoice is authoritative.

The details are in [AGENT_RUNTIME.md](../AGENT_RUNTIME.md#claude-agent-sdk-worker),
[SECURITY.md](../SECURITY.md#claude-anthropic-api-key) and
[BILLING.md](../BILLING.md#byok).

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Claude subscription OAuth sign-in | Anthropic's terms do not allow consumer subscription credentials to power a hosted third-party product. |
| Our own HTTP client for the Messages API | Rebuilds retries, typed errors and structured output that the official SDK already ships. |
| A server-level `ANTHROPIC_API_KEY` | Makes the operator pay for workspace choices, and is exactly the ambient fallback this design avoids. |
| Silent fallback to the server key when the workspace key fails | Changes who pays without the workspace knowing. |
| Running the agent without an OS sandbox | The path guard is a correctness aid, not a security boundary. |

## Consequences and trade-offs

- A second agent runtime exists next to Pi. Both share the `SceneWorker`
  contract, the prompt builder and the path guard, so the scene contract stays
  single-sourced.
- bubblewrap needs unprivileged user namespaces. Docker's default seccomp and
  AppArmor profiles may block them, in which case the Claude worker is
  unavailable until the operator allows them, or sets
  `CLAUDE_WORKER_SANDBOX=none` where the container itself is the isolation
  boundary.
- The Claude Code binary is a separate process per scene, which costs more
  start-up time and memory than Pi's in-process sessions.
- Waived director and critic credits reduce platform revenue per job; the
  orchestration fee still covers the platform's own work. Reservations stay
  conservative and do not apply the waiver; unused credits are returned when
  the job settles.
- Trace costs for Claude worker runs are estimates.

## Migration

Upgrading either SDK changes only `packages/llm` or
`packages/claude-agent-runtime`, and their tests use mocked clients. Workspaces
with no Claude settings keep the server defaults, so nothing changes for them.
If Anthropic approves subscription use in writing, the reserved `connecting`
and `expired` statuses carry an OAuth flow without changing the role model.
