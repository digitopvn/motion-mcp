# Docs report: workspace Anthropic key (BYOK), per-role Claude backends, Claude scene worker

## Files

- Created `docs/decisions/0013-claude-sdk-first-byok.md` (ADR: SDK-first, API key only, subscription OAuth `blocked_by_policy`, role abstraction, per-job pinning, no ambient credentials, sandbox, billing).
- `docs/decisions/README.md`: 0013 row.
- `docs/ARCHITECTURE.md`: `llm` row (Anthropic client), new `claude-agent-runtime` row, model-role note pointing to `claude-providers.ts` / `roleBackend`, `CREDENTIALS_ENCRYPTION_KEY` and new `CLAUDE_WORKER_SANDBOX` config rows, bubblewrap in the deploy diagram.
- `docs/AGENT_RUNTIME.md`: title, intro pointer, new "Claude Agent SDK worker" section with "Sandbox" subsection.
- `docs/SECURITY.md`: third credential kind, "Claude (Anthropic API key)" subsection with the `/api/providers/claude*` route table and status enum, "Claude worker isolation" section (threat model, Docker caveat), "No public shell" wording.
- `docs/MCP_API.md`: `internal-opus` availability now includes a workspace director on its Anthropic key (`internalDirectorAvailable`).
- `docs/BILLING.md`: director/critique BYOK waiver only on the workspace key, `modelByok` quote flag, SDK cost is an estimate, reservations not reduced.
- `docs/README.md`: AGENT_RUNTIME index row.
- `README.md`: feature bullet, package row, bubblewrap requirement.
- `.env.example`: `CLAUDE_*` keys with `config.ts` defaults; note there is no server `ANTHROPIC_API_KEY`.
- `Dockerfile`: `bubblewrap` added to apt-get with a comment.

Not changed: `apps/marketing/public/llms.txt` and `index.md` (they list no provider/BYOK capabilities).

## Validation

- Every claim was checked against the source in the working tree. Relative links and anchors in the touched docs resolve.
- `npx biome check .` passed (220 files, no fixes).

## Open

- `docs/DIRECTOR_PROTOCOL.md` (`internal-opus` row: "Requires `OPENROUTER_API_KEY`") and `llms.txt` (`internal-opus` "through OpenRouter") are now incomplete for workspaces whose director uses their Anthropic key. Both were outside the assigned file list, so they were left unchanged.
