# Claude Agent SDK runtime + dashboard Claude auth (issue #2)

Status: in progress · Branch: claude/eloquent-dirac-ayw4z2 → dev

## Outcome
A workspace can store its own Anthropic API key (BYOK) from the dashboard and choose, per role,
which backend runs it: Director/Critic on `openrouter` or `anthropic-api`, the scene worker on `pi`
or `claude-agent-sdk`. Subscription OAuth is visible but `blocked_by_policy` with no login button.

## Decisions
- SDK-first: scene worker uses `@anthropic-ai/claude-agent-sdk` (`query()`), Director/Critic use the
  official `@anthropic-ai/sdk` Messages API. Recorded in ADR 0013.
- BYOK is workspace-only. No server-level Anthropic key; ambient `ANTHROPIC_API_KEY` and `~/.claude`
  are never read by jobs (scrubbed env, isolated `CLAUDE_CONFIG_DIR`, `settingSources: []`).
- Fallback preference per workspace: `none` (default, no silent spend) or `server` (server defaults,
  charged in credits). Never silently swaps keys.
- Backend selection is snapshotted into the job at enqueue; later setting changes do not affect it.
- Key test uses `GET /v1/models` (free).
- Billing: `creative_direction` / `creative_critique` become BYOK-waivable and are waived only when the
  workspace's own Anthropic key paid. Orchestration fees still apply. SDK `total_cost_usd` is shown
  as an estimate.
- Sandbox: `CLAUDE_WORKER_SANDBOX=bwrap|none` (default bwrap). bwrap probe fails → the Claude worker
  is unavailable and the job falls back per preference. Process group kill on abort/timeout.
- OAuth subscription: `blocked_by_policy` until Anthropic gives written approval.

## Non-goals
- Subscription OAuth login flow (blocked).
- Live billable calls in CI.

## Phases
1. [x] `AnthropicClient` gateway in `packages/llm` + prices.
2. [x] `ClaudeSceneWorker` in `packages/claude-agent-runtime` (sandboxed spawn, path-guard hook).
3. [x] Storage + `WorkspaceProviders` Claude credential/settings + role resolution; job snapshot.
4. [x] Director/Critic per-call gateway; BYOK metering.
5. [x] Dashboard API `/api/providers/claude*` + Providers page section.
6. [x] Tests (mocked SDK), docs (ADR 0013, ARCHITECTURE, AGENT_RUNTIME, SECURITY, MCP_API, BILLING,
       README, .env.example, Dockerfile), review, PR → dev.

## Acceptance
- Status enum `unconfigured|connecting|connected|expired|revoked|unavailable|blocked_by_policy`.
- Endpoints: GET /api/providers/claude, PUT/DELETE /api/providers/claude/api-key,
  POST /api/providers/claude/test, PUT /api/providers/claude/settings.
- No key value in any response or log; workspace isolation tested.
- `pnpm check` passes; dashboard builds.
