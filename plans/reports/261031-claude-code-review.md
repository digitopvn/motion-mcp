# Code review: Claude BYOK roles + Claude Agent SDK scene worker (issue #2)

Scope: the changes now committed as `8a0c25b` (they were committed while this review was running; the review applies to HEAD). Docs/README not reviewed.
Files: packages/claude-agent-runtime/*, packages/llm/src/anthropic-client.ts, packages/pipeline/src/{claude-providers,jobs,build-version,motion-service,workspace-providers,runtime}.ts, packages/billing/src/{prices,quote}.ts, packages/director/src/director.ts, packages/database/src/{entities,schema}.ts, apps/mcp-server/src/dashboard-providers.ts, apps/dashboard/src/pages/claude-provider.tsx, plus tests.

Checks run:
- `vitest --project unit packages/claude-agent-runtime packages/llm packages/pipeline packages/billing`: 72/72 pass.
- `apps/mcp-server/test/claude-providers.test.ts`: 5/5 pass.
- `tsc --noEmit`: clean. `biome check` on the changed paths: clean.
- I ran the real bwrap layout on this host by hand: the project is read-only, `compositions/` is writable, `/root` is hidden, DNS works.
- I confirmed in the SDK source (0.3.303) that `options.env` replaces `process.env` (`Ct = v ? {...v} : {...process.env}`). The SDK adds only `CLAUDE_CODE_ENTRYPOINT`, its version and similar flags.
- I confirmed in `@anthropic-ai/sdk` 0.124 that an explicit `apiKey` skips the credential chain and profiles, and that its debug logs redact `x-api-key`.

## Overall

The structure is sound: the selection is pinned at enqueue, the key is sealed with an AAD bound to the workspace, the env is scrubbed and the SDK does not merge `process.env`, `settingSources: []`, a strict MCP config, a tool allowlist plus the hook guard, and fallbacks are explicit. Nothing here leaks the key in normal operation.

There are three confirmed bugs that matter:
- the quote never uses the new `modelByok`, so BYOK workspaces still have director and critic credits reserved;
- an in-flight job can mark a freshly rotated key as "revoked";
- Anthropic billing and permission errors are treated as a revoked key.

## Confirmed bugs

### High

**H1. `modelByok` is never set, so BYOK jobs still reserve director and critic credits.**
- Where: `packages/billing/src/quote.ts:21,67`; callers `packages/pipeline/src/scene-assets.ts:80-90` (`quoteWithAssets`) and `motion-service.ts:220,347`.
- Evidence: a grep shows no producer of `modelByok` anywhere in `packages/` or `apps/`. Only the billing unit test sets it.
- Failure: a workspace has director and critic on `anthropic-api` and 150 credits. A create job quotes 20 + 100 (director) + 40×critiqueCap + render, so `reserveForJob` throws INSUFFICIENT_CREDITS. If the caller passes `budgetCredits`, it throws BUDGET_EXCEEDED (`billing-guard.ts:72`), even though the meter would waive both lines at capture.
- Impact: the user-visible `quotedCredits` and `estimatedCredits` overstate the cost. The final charge is correct (the meter waives), but the job is refused or over-reserved.
- Fix: take the snapshot before quoting (it is currently taken after the reservation, inside `withReservation`) and pass `modelByok` per role. The waiver must be per role, because director and critic can differ: e.g. `JobPlan.directorByok` / `critiqueByok`, or quote the two lines separately.
  - Waive only when `fallback === "none"`. With `fallback: "server"` the job may still bill the server path, so reserve the full price.
  - Add a pipeline test that a BYOK create job reserves without the 100 + 40n.

### Medium

**M1. A stale in-flight job can mark a newly rotated key as revoked.**
- Where: `packages/pipeline/src/claude-providers.ts:409-418` (`onAuthRejected`) and `:401-406` (`setKeyState`).
- Failure:
  1. Job A resolves key K1 and starts.
  2. K1 is revoked in the Anthropic console.
  3. The user saves K2 (`setKey` writes `keyState: valid`).
  4. Job A's next call gets a 401 on K1, and `onAuthRejected` writes `keyState: rejected`.
  5. The dashboard now shows K2 as "revoked". `resolve()` (`:340`) refuses K2 for every later job: they fail with `fallback: none`, or silently move to server credits with `fallback: server`. This lasts until the user clicks "Test".
- Fix: carry the credential identity into the watcher (`record.updatedAt`, the record id, or a hash of the ciphertext) and only write `rejected` if the stored record still matches. Store that fingerprint in `keyState` and have `resolve()` compare it.

**M2. Lost updates on `workspace.claude`, because both writers read, modify and write the whole object.**
- Where: `setKeyState` (`:401-406`) and `updateSettings` (`:272-302`). Both read the whole `claude` object and write it back; the file repo replaces the field (`file-repository.ts:366-372`).
- Failure: `onAuthRejected` from a running job and a dashboard "Save roles" run at the same time. Either the role change is reverted, or the `rejected` state is lost.
- Fix: keep `keyState` outside the settings object (e.g. on the credential record), or do an atomic JSON-path update or compare-and-set.

**M3. Billing exhaustion and permission errors are treated as a revoked key.**
- Where:
  - `claude-agent-runtime/src/claude-worker.ts:418`: `billing_error` → `AUTH_REJECTED`.
  - `llm/src/anthropic-client.ts:194`: `PermissionDeniedError` (403) → `AUTH_REJECTED`.
- Failure (billing): the workspace's Anthropic credit balance runs out. The worker reports `auth_rejected` and the key is marked "revoked". "Test" (`GET /v1/models`, free) then succeeds and resets it to valid, the next job fails again, and the UI wrongly says "Anthropic rejected the saved key".
- Failure (403): a 403 for a single model (no access to the chosen Opus model, or an org or region restriction) revokes the key for every role.
- Fix: map only 401 / `authentication_failed` to `AUTH_REJECTED`. Map billing errors and 403 to a distinct reason (`provider_billing`, `provider_permission`) that fails the role clearly without flipping `keyState`.

**M4. A cancel during worker startup is ignored, so the run continues to timeout at the workspace's expense.**
- Where: `claude-worker.ts:270-295`. `validate()` checks `signal.aborted` synchronously; then `await mkdtemp`, `await mkdir` ×2 run before `addEventListener("abort")`. A signal aborted in that window never fires its listener.
- Failure: the user cancels the job just as a scene starts. The agent runs for up to `CLAUDE_WORKER_TIMEOUT_MS` (6 min by default) and bills the workspace key. The job also hangs because `runSceneWorker` awaits it.
- Fix: after registering the listener, add `if (input.signal?.aborted) onAbort();`. The SDK then sees an already-aborted controller. Moving the `mkdir(compositionsDir)` inside the `try` also stops `homeDir` leaking if it throws (currently `mkdtemp` happens before the `try`/`finally` that removes it).

**M5. Unbounded growth of the global secret set, driven by unauthenticated-quality input.**
- Where: `claude-providers.ts:210`. `registerSecret(key)` runs before `verify`.
- Failure: any logged-in user can `PUT /api/providers/claude/api-key` with many distinct well-formed fake keys. Each one is added to the process-global `knownSecrets` forever (`shared/src/redact.ts:35`). Every `redact()` call (every log line, span attribute and error) loops over all of them. There is no rate limit on this route or on `/claude/test`, which also makes the server a free oracle for checking whether a stolen Anthropic key is valid.
- Fix: register only after a successful verify (the `sk-ant-` regex already covers redaction of unverified input). Add a `RateLimiter` (the class already exists in `dashboard-http.ts:119`) per user and per IP on PUT `api-key` and POST `test`.

### Low

**L1. Over-reach in the bwrap layout: all of `/etc` is bound into the sandbox.**
- Where: `sandbox.ts:31,100`.
- Detail: Claude Code always loads managed policy settings from `/etc/claude-code/managed-settings.json`, regardless of `settingSources`. If the host has one (for example an operator or dev box with enterprise policy), its `env` (`ANTHROPIC_BASE_URL`), `apiKeyHelper` or `hooks` (shell commands) apply inside the agent. That would bypass "never use server ambient" and the "no Bash" rule.
- Fix: bind only the specific `/etc` entries needed (`resolv.conf`, `hosts`, `nsswitch.conf`, `ssl`, `ca-certificates`, `passwd`, `group`, `localtime`), or overlay `--tmpfs /etc/claude-code`.

**L2. The sandbox probe does not match the real argv.**
- Where: `sandbox.ts:45-47`. The probe uses `--ro-bind / /`; the real run adds `--new-session --proc /proc --dev /dev --tmpfs /tmp`.
- Failure: in Docker or Kubernetes with userns allowed but `/proc` masked, the probe passes, the dashboard says the worker is available, and every real run fails at spawn.
- Fix: probe with `sandboxArgv(...)` against a temp project, running `/bin/true`.
- Also: the probe uses `spawnSync` with a 10 s timeout. It blocks the event loop on the first `GET /claude` or first job, and a failure (including a transient timeout) is cached for the life of the process. Probe asynchronously at startup, and do not cache timeouts.

**L3. stderr redaction runs per chunk, not per line.**
- Where: `sandbox.ts:153`. `chunk.split("\n")` on raw `data` events; a line (and a key) can be split across two chunks. Neither fragment matches the registered secret, and the second fragment no longer matches the `sk-ant-` pattern.
- Impact: the last stderr line is put into the user-visible error at `claude-worker.ts:335`. It is unlikely the CLI prints the key, but this is the only stderr path, so make it line-buffered (`readline`, or carry the partial line over).

**L4. `fallback: server` for the worker uses `sceneWorkerFor(workspace)`, which may be the workspace's own Pi sign-in.**
- Where: `jobs.ts` executeJob. The warning says "used the server default". Fix the wording, or skip the workspace Pi worker in this path.

**L5. Render jobs also pin and resolve the Claude selection.**
- Where: `motion-service.ts:575`. `resolve()` then decrypts the key, builds a worker, and adds "Claude scene worker unavailable … deterministic" warnings to render jobs that never run a worker or a director.
- Fix: do not snapshot for render jobs.

**L6. BYOK model costs are counted as platform COGS.**
- `AnthropicClient` and the worker call `span.recordModelCall({ costUsd })`, which adds to `costs.api`. That flows into the job's `costUsd` and margin (`observability/tracer.ts:93,183`), although the workspace paid Anthropic. This skews margin reporting.
- Fix: record BYOK calls with `costUsd: 0` plus an `estimatedCostUsd` or `byok` attribute, or exclude provider `anthropic*` BYOK calls from COGS.

**L7. UI copy and stale form state.**
- The radio button says "Stop the job". With `fallback: none`, a missing critic key only adds a warning and the worker falls back to deterministic; only the director stops the job.
- `RoleSettings` initialises `useState(data.settings)` once and does not resync after `reload()`.
- Saving persists the server's default model ids explicitly, so a later change to `CLAUDE_MODELS` that removes one makes every unrelated settings save fail validation (`claude-providers.ts:275-280`).

**L8. `AnthropicClient` still honours server `ANTHROPIC_CUSTOM_HEADERS` (SDK 0.124 `client.js` constructor).**
- The server's ambient headers would be added to workspace-key requests. Hardening fix: pass `defaultHeaders` explicitly, or delete that env read path by constructing with `fetchOptions`/`defaultHeaders`.

## Verified non-issues

- **Environment scrubbing:** the SDK uses the `env` option verbatim, `NODE_OPTIONS` and `DEBUG` are deleted, and there is no `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `~/.claude` (private `HOME` and `CLAUDE_CONFIG_DIR`).
- **Tool guard mapping:**
  - `Read`/`Write`/`Edit` map `file_path` onto read/write/edit.
  - `Glob` (`path` defaults to `.`; an absolute `pattern` or a `..` segment is rejected) and `Grep` (`path`, `glob`) map onto find/grep.
  - Unknown tools are denied; `submit_scene` passes through.
  - A `~` path resolves against the server home in the guard, which is outside the project and therefore blocked (fail-closed).
  - Brace patterns like `{..,x}` are harmless because ripgrep matches globs relative to the search root.
  - Separately, `tools` limits the built-ins, `dontAsk` with `allowedTools` applies, and `disallowedTools` removes Bash and web tools.
- **Process tree:** in bwrap mode the outer bwrap is in our detached process group and the inner tree is in a new PID namespace with `--die-with-parent`, so killing the group (or a server crash) tears it all down. In `none` mode a server crash orphans the agent (detached, no PDEATHSIG). That is acceptable given the documented "VM per job only" intent.
- **Billing at capture:** the meter's `byok: Boolean(backend)` is set only when the workspace gateway actually served the call. A server fallback is billed normally. There is no double charge.
- **Dashboard isolation:** every route uses the session `workspace`, mutations go through the Origin check, Zod errors do not echo input (zod 4), and the overview returns only `hint` and `updatedAt`.
- **Secrets at rest:** the AAD `${workspaceId}:claude:anthropic` prevents moving a ciphertext between workspaces.

## Recommended actions (in order)

1. H1: wire `modelByok` per role from the pinned snapshot into `quoteWithAssets`, and take the snapshot before quoting.
2. M1/M2: version `keyState` against the credential record, and stop full-object read-modify-write.
3. M3: separate billing and 403 errors from `AUTH_REJECTED`.
4. M4: check `signal.aborted` after registering the listener, and move `mkdir` inside the `try`.
5. M5: register the secret after verify, and rate-limit the key and test routes.
6. L1/L2: narrow the `/etc` binds, and probe with the real argv asynchronously.

## Metrics

- Typecheck: clean. Lint (biome, changed paths): 0 issues.
- Tests: 77 pass (72 unit + 5 mcp-server). There is no test for the quote waiver in the pipeline, the stale-key race, or the cancel-before-listener window.

## Unresolved questions

- Should `fallback: server` reserve the server price up front? (Recommended: yes.)
- Should `keyState: rejected` block use, or only warn until re-tested? Today it blocks, which amplifies M1 and M3.

## Resolution

- H1 fixed: the selection is pinned before quoting, and `quoteJob` takes `directorByok` / `criticByok` per role. The waiver applies only with fallback `none`.
- M1 fixed: a mid-job rejection marks the key revoked only when the stored credential's `updatedAt` matches the key the job resolved. A regression test covers this.
- M3 fixed: HTTP 403 maps to `permission_denied`, and the worker's `billing_error` maps to a PROVIDER error with that reason. Neither one revokes the key. Both have tests.
- M4 fixed: the worker cleans up its temp home when setup fails, and it honours a signal that was already aborted.
- M5 fixed: the key is registered for redaction only after it is verified. Key save and test are limited to 10 calls per workspace per 10 minutes, and a test covers the HTTP 429.
- L1 fixed: `/etc/claude-code` is masked with a tmpfs when it exists.
- L3 fixed: stderr is buffered by line before redaction.
- L5 fixed: render jobs do not pin a Claude selection.
- L7 fixed: the fallback wording is clearer, and the roles form remounts when the settings change.
- Deferred to a follow-up issue: M2 (concurrent writes to `workspace.claude`), L2 (the sandbox probe does not match the real argv), L4 (server fallback wording for the worker), L6 (BYOK model cost counted as COGS) and L8 (`ANTHROPIC_CUSTOM_HEADERS`).

Verification: `pnpm check` passes with 37 test files, 313 passed and 1 skipped.
