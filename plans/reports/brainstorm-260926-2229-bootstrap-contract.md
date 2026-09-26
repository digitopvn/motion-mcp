# Bootstrap Contract — Motion MCP

Mode: `--auto` (no `--ask`, no `--yagni`). Gaps were decided from the brief, the workspace and the target VPS; each decision is recorded as an assumption below.

## Outcome

An open-source (MIT) motion-video production runtime exposed as a Streamable HTTP MCP server. A host model (Claude, ChatGPT, Pi or any MCP client) calls `motion_create` with a brief, optionally with a host-produced creative spec, and receives a rendered MP4. Opus is used only for creative direction and critique; a bounded decision model (Jev) routes work; Pi plus cheap models implement HyperFrames scenes; FFmpeg finishes the output.

## Constraints

- Reuse HyperFrames, Pi, multix and pi-multix instead of rebuilding their capabilities.
- Motion IR is renderer-neutral; HyperFrames is the first compiler target.
- Director mode is explicit (`host-opus` | `internal-opus` | `custom`), never inferred from model names.
- CI never calls paid frontier models; live tests are opt-in.
- Secrets never enter prompts, logs or git. `.env` stays local; deployment secrets flow through GitHub Actions secrets.
- The public MCP tool surface stays at eight tools.

## Non-goals for this bootstrap

- A polished dashboard, marketing site, billing, hybrid search and Taste Memory learning are designed (docs, schemas, ADRs) but are not blocking the vertical slice. They land in later roadmap phases.
- Team/workspace management, 4K cloud rendering and generative video are out of the first slice.

## Acceptance criteria (vertical slice)

1. `motion_create` over Streamable HTTP accepts `{ brief }` (internal-opus) and `{ brief, creativeSpec }` (host-opus) and returns a project id plus job status.
2. The director stage produces a validated Taste Packet and Motion IR v0.1 (zod-validated, JSON Schema exported).
3. Pi (or the deterministic compiler fallback) produces a HyperFrames project from Motion IR; `hyperframes lint` passes.
4. A low-res preview and a final 1080p MP4 render locally; FFmpeg finishing produces a web-optimized MP4.
5. Jev routing returns a structured decision with a configurable model id and a deterministic fallback.
6. Every run writes a hierarchical trace with cost fields.
7. `npm run check|test|lint|typecheck|build` pass; tests cover schemas, routing, compile, MCP protocol, redaction and ledger math.
8. The twelve required docs plus `docs/decisions/` ADRs exist.

## Definition of done

Vertical slice verified locally end-to-end (brief to MP4). Release to `app.motion.digitop.ai/mcp` and the GitHub repo `digitopvn/motion-mcp` is authorized by the brief and is attempted; the VPS currently blocks Docker for the `dev` user (see risks), so production verification depends on that access.

## Assumptions

- Internal Opus and Jev calls go through OpenRouter (`OPENROUTER_API_KEY` is present; no direct Anthropic key). Model ids are configuration.
- PostgreSQL is the system of record in production; the slice uses a file-backed repository behind the same interface so the engine runs without a database.
- Object storage is R2 via the S3 API; the slice writes to a local artifacts directory behind the same interface.
- Package manager: pnpm workspaces (available locally and on the VPS).
- Target VPS: Debian 13, 16 cores, 62 GB RAM, Node 22, Chrome present, no FFmpeg, no Docker group access for `dev`, nothing on ports 80/443. Public ingress is planned through a Cloudflare Tunnel container.
