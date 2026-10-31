# Security

This document covers what Motion MCP protects: provider credentials, platform
API keys, tenant projects and assets, and the host machine that runs untrusted,
model-written HTML. Each section says what is enforced in code today and what
is still **planned**.

## Secrets

- Secrets never enter prompts, tool results, task text, logs, traces or git.
  Models receive capabilities, meaning tools, and never keys.
- `.env` exists only on local machines and on the VPS, and is ignored by git.
  Deployment secrets flow through GitHub Actions secrets and the VPS `.env`.
- CI never calls paid frontier models. Live-model tests run only through the
  opt-in `pnpm test:live` project.
- Documentation never contains secret values, tokenized URLs or customer data.

## Provider credentials (BYOK)

Each workspace can bring its own model providers from **Dashboard > Model
providers** (`/api/providers`). Three kinds are stored:

- **pi providers**, signed in with an API key, or with OAuth that grants API
  access (such as OpenRouter), through pi's own `ModelRuntime.login`. OAuth for
  personal subscriptions (pi marks these `isSubscription`, for example Claude
  or ChatGPT plans) is not offered, because those plans' terms do not cover use
  by a hosted service. The dashboard relays pi's prompts (sign-in link, device
  code, pasted redirect URL or API key) without seeing more than the prompt;
  sessions are bound to one workspace, expire after 10 minutes, and errors are
  redacted before they reach the browser.
- **multix API keys**, limited to the env names multix providers declare.
- **An Anthropic API key** for Claude roles, described in
  [Claude (Anthropic API key)](#claude-anthropic-api-key).

Storage and use (`packages/pipeline/src/workspace-providers.ts`):

- Every value is sealed with AES-256-GCM under `CREDENTIALS_ENCRYPTION_KEY`
  (`packages/shared/src/sealed-box.ts`), with a fresh nonce per write and the
  record's `workspace:kind:provider` as additional data, so a ciphertext copied
  to another workspace or provider fails authentication. Rows keep only the
  ciphertext, nonce, a key id and, for long API keys, the last 4 characters.
- The master key lives only in the runtime secret store (VPS `.env`). Without
  it the feature is off and every job uses the server's own worker.
- Decrypted values are registered with the redactor before use. Unlike pi's
  file store, stored values are never expanded as `$ENV` or run as `!command`.
- A job uses the workspace's chosen pi model only when the workspace holds a
  stored sign-in for that provider, so pi's ambient environment fallback never
  spends the server's keys on a workspace's behalf.
- Key rotation is **planned**: changing the master key makes stored sign-ins
  unreadable, and workspaces must connect again.
- Scene image generation uses the workspace's multix keys when they unlock an
  image provider, and otherwise the server's own multix keys. The two sets are
  never mixed in one job, so an image billed as BYOK was always paid by the
  workspace. Only image keys are used today; keys for video, speech, music and
  sound effects are stored for later steps. Every run goes through the scrubbed
  environment described in [multix environment scrubbing](#multix-environment-scrubbing).

### Claude (Anthropic API key)

A workspace may store one Anthropic API key and run the director, the critic
or the scene worker on it ([ADR 0013](decisions/0013-claude-sdk-first-byok.md)).
`WorkspaceClaude` in `packages/pipeline/src/claude-providers.ts` owns the
handling:

- Only API keys (`sk-ant-api…`) are accepted; admin keys are refused. Before a
  key is stored it is verified with Anthropic's free `GET /v1/models`, and a
  rejected key is not stored.
- The key is sealed like every other credential, with
  `${workspaceId}:claude:anthropic` as additional data. Responses carry only
  the last 4 characters as a hint, and the key is registered with the redactor
  before any use.
- When Anthropic rejects a stored key, during a test or mid-job, the key is
  marked rejected and the dashboard shows `revoked`. Jobs stop using it until
  it is replaced or a test passes again.
- The server holds no Anthropic key, and no role reads the server's
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `~/.claude`. Clients get the key
  explicitly, and the agent process gets a scrubbed environment and an
  isolated `CLAUDE_CONFIG_DIR`. A workspace key that is missing or rejected
  either fails the role or, if the workspace chose the `server` fallback, uses
  the server defaults billed in credits. Keys are never swapped silently.
- Claude subscription sign-in is `blocked_by_policy`: Anthropic does not permit
  consumer subscription credentials to power third-party hosted products, so
  no login is offered.

The dashboard routes (`apps/mcp-server/src/dashboard-providers.ts`) require a
dashboard session, act only on the caller's workspace, and never return the
key. Every route except `GET` needs `CREDENTIALS_ENCRYPTION_KEY`.

| Route | Body | Result |
|---|---|---|
| `GET /api/providers/claude` | | The overview: `status`, `apiKey` (hint and update time, or `null`), `keyState`, the effective `settings`, the selectable `models`, `worker` availability and sandbox, and `subscription` (`blocked_by_policy` with the reason). |
| `PUT /api/providers/claude/api-key` | `{ apiKey }` | Verifies and stores the key, then returns the overview. A rejected key is `invalid_input`. |
| `DELETE /api/providers/claude/api-key` | | 204, or `not_found` when no key is stored. |
| `POST /api/providers/claude/test` | | Re-checks the stored key: `{ keyState, overview }`. |
| `PUT /api/providers/claude/settings` | Any of `director`, `critic` (`openrouter` or `anthropic-api`), `sceneWorker` (`pi` or `claude-agent-sdk`), `directorModel`, `criticModel`, `workerModel` (from `CLAUDE_MODELS`) and `fallback` (`none` or `server`) | Returns the overview. Moving a role onto Claude needs a stored key, and the scene worker also needs a working sandbox. |

`status` is one of `unconfigured`, `connecting`, `connected`, `expired`,
`revoked`, `unavailable` (provider keys are off on this server) or
`blocked_by_policy`. `connecting` and `expired` are reserved for a future
subscription sign-in and are not returned today. The response types are
`ClaudeOverview` and `ClaudeStatus` in `claude-providers.ts`.

## Redaction

The shared redactor in `packages/shared/src/redact.ts` is the authority for
what is masked. It combines two mechanisms:

- **Value-based.** At startup every environment variable whose name contains
  `KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL` is registered, along
  with the configured provider, storage, Polar and signing secrets. Registered
  values are scrubbed verbatim wherever they appear.
- **Pattern-based.** Bearer and Basic credentials, common provider key shapes
  (including OpenRouter `sk-or-…`, Polar tokens and Motion MCP `mmcp_` keys),
  JWTs, PEM private keys, signed-URL signature parameters, and secret-looking
  key/value pairs.

It runs on traces before they are stored, on public error details, on job error
messages, on decision state sent to Jev adapters, and on provider error bodies.
Its unit tests are in `packages/shared/test/redact.test.ts`.

Gaps: `DATABASE_URL` is not registered by name, and email addresses and other
personal data in free text are not redacted. Both are **planned**.

## MCP authentication

- `/mcp` requires `Authorization: Bearer <api key>`, and a missing or unknown
  key gets 401 before any tool runs.
- Workspace keys come from `pnpm motion keys create`: `mmcp_` plus 256 random
  bits, shown once. Only the SHA-256 hash and a short display prefix are stored,
  and lookups ignore revoked keys. A revocation command is **planned**.
- Static keys from `MOTION_API_KEYS` map to the default workspace and are
  compared as hashes in constant time.
- Unauthenticated access exists only with `NODE_ENV=development` and no static
  keys, and the server logs a warning when it is on.
- Each key is scoped to one workspace, and every project lookup checks that the
  project belongs to the caller's workspace. A project in another workspace is
  reported as `not_found`.
- OAuth (MCP authorization with resource metadata) is not in v1.

## DNS rebinding

The HTTP app validates the `Host` header on every route against
`ALLOWED_HOSTS` plus the host of `PUBLIC_BASE_URL`, and rejects any other host
with 403.

## Artifact URLs and published renders

- Local-storage artifacts are reachable only through `/artifacts/*` URLs signed
  with HMAC-SHA256 over the key and expiry, checked in constant time, and
  capped in lifetime. The secret is `ARTIFACT_SIGNING_SECRET`; see
  [ARCHITECTURE.md](ARCHITECTURE.md#configuration) for its fallbacks. With R2,
  clients get presigned R2 URLs instead.
- Storage keys are validated against a strict pattern, and the local store
  rejects any key that escapes its root.
- Artifacts are served with `nosniff`, a `sandbox` Content Security Policy and
  an inline disposition, and compositions are served as plain text, so
  model-written HTML never executes in a viewer's browser.
- Only succeeded final renders can be published at `/v/<renderId>`. Unlisted
  renders carry `X-Robots-Tag: noindex`.

## Polar webhooks

The webhook route reads the raw body and verifies the Standard Webhooks
signature against `POLAR_WEBHOOK_SECRET` in constant time, with a five-minute
replay window. Grants are idempotent per order id. The route returns 404 when
no secret is configured.

## Pi isolation

Pi's `cwd` is not a sandbox, so these controls apply
([AGENT_RUNTIME.md](AGENT_RUNTIME.md#isolation)):

- Pi runs inside the production container as the non-root `node` user.
- Shell tools are not granted, and a path-guard extension limits file tools to
  the project directory and limits writes to the scene's own composition file.
- Pi's resource discovery is disabled: a private agent directory, no
  extensions, skills or context files from the user or the project.
- Generated HTML is untrusted. It is linted, checked and rendered only inside
  the pipeline, and it is never fed from raw user text into code-bearing
  HyperFrames inputs.
- **Planned:** per-job container or mount isolation, so that the only writable
  path is the job's own directory.

## Claude worker isolation

The Claude Agent SDK worker runs the Claude Code binary as a separate process,
so it gets an OS sandbox on top of the shared path guard
([AGENT_RUNTIME.md](AGENT_RUNTIME.md#sandbox)):

- bubblewrap with private namespaces except the network, the project mounted
  read-only, only `compositions/` writable, a private temporary home and a
  fresh `/tmp`;
- `prlimit` caps on CPU time and file size, and no core dumps;
- its own process group, killed as a whole on abort, timeout or task end;
- no shell, web or subagent tools, and no settings, hooks or MCP servers from
  the host.

The threat it addresses is a model-driven agent with file tools reading or
writing outside its scene, or reaching host credentials. The network stays
open because the agent must call the Anthropic API.

Docker's default seccomp and AppArmor profiles may block the unprivileged user
namespaces bubblewrap needs. The Claude worker is then reported unavailable.
`CLAUDE_WORKER_SANDBOX=none` removes the sandbox and keeps only the resource
limits, the scrubbed environment and the path guard; use it only when the
container or VM itself isolates each job.

## No public shell

No public tool, and no tool granted to Pi or the Claude worker, executes arbitrary commands. FFmpeg,
HyperFrames and multix are invoked with `execFile`-style argv arrays built from
typed parameters, with a scrubbed environment.

## multix environment scrubbing

multix loads keys from `process.env`, then from `<cwd>/.env`, then from
`~/.multix/.env`. A `.env` file planted in a user-controlled directory could
inject keys, base URLs or model overrides. The runner in `packages/media`
defends against this ([ADR 0007](decisions/0007-multix-cli-runner.md)):

- It runs multix in a fresh, runner-owned temporary directory that never
  contains a `.env` file.
- It builds the child's environment from a scrubbed base plus only the keys the
  chosen provider needs, `MULTIX_OUTPUT_DIR`, `NO_COLOR` and
  `MULTIX_DISABLE_HOME_ENV=1`.
- It refuses `multix check` and `multix update`, and computes key availability
  itself.
- It passes model-authored text as `--flag=value` or after `--`, so text cannot
  inject options, and it accepts only real files inside the output directory.

The runner is implemented and tested, but the pipeline does not call it yet;
asset generation is **planned** ([ROADMAP.md](ROADMAP.md)).

## Third-party telemetry and egress

- HyperFrames runs with `HYPERFRAMES_NO_TELEMETRY=1` and
  `HYPERFRAMES_NO_UPDATE_CHECK=1`, set both in the adapter and in the image
  ([ADR 0005](decisions/0005-hyperframes-hybrid-integration.md)).
- `hyperframes snapshot` is always called with `--describe false`, so frames
  are never sent to a vision provider implicitly.
- Compositions vendor GSAP and embed their fonts, so a render fetches nothing.
