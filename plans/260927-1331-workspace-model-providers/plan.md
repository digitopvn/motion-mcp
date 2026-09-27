# Workspace model providers (pi + multix)

Status: done · Branch: main

## Outcome
Each workspace manages its own model-provider sign-ins from the dashboard:
- `pi` agent providers, connected the same two ways the pi CLI supports: OAuth (Claude Pro/Max, ChatGPT/Codex, GitHub Copilot, …) and API key.
- A chosen pi provider/model that the workspace's jobs use for scene building; without one, jobs keep the server default.
- API keys for the `multix` CLI (Gemini, OpenAI, OpenRouter, MiniMax, fal, Cloudflare, Leonardo, ElevenLabs, BytePlus).

## Decisions
- Scope: per workspace (BYOK), chosen by the user on 2026-09-27.
- Stored values are encrypted at rest with AES-256-GCM under `CREDENTIALS_ENCRYPTION_KEY`; without that key the feature reports "not configured" and stores nothing.
- Stored values never leave the server: the API returns only provider ids, auth type, a 4-char hint and timestamps.
- Pi sign-in reuses `ModelRuntime.login()` from pi; the dashboard relays its prompts (auth URL, device code, paste-code) by polling a server-side login session.
- Billing unchanged: platform fees still apply when a workspace key runs a job.

## Non-goals
- Instance-admin UI (server defaults stay in `.env`).
- Wiring multix into a pipeline stage (no stage calls multix yet); the runtime exposes the per-workspace env for when one does.

## Phases
1. [x] Storage: `SealedBox`, `ProviderCredential` entity + file repo, `Workspace.piModel`.
2. [x] Runtime: encrypted pi `CredentialStore`, per-workspace `ModelRuntime`/`PiWorker`, `JobScope.sceneWorker`, multix env resolver.
3. [x] API: `/api/providers` routes and pi login sessions.
4. [x] Dashboard: Providers page.
5. [x] Tests, docs (`.env.example`, docs), deploy with a generated production key, live check.

## Acceptance
- Tests cover encryption round-trip, repo, API-key login, OAuth relay (fake provider), model selection, multix keys, workspace isolation and no stored value in responses.
- Typecheck, lint and tests pass; dashboard builds.
- Production: Providers page loads; storing and removing a multix key works.
