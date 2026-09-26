# Motion MCP

AI-native motion-video production over the Model Context Protocol. Ask Claude, ChatGPT, Pi or any MCP
client for a video; Motion MCP spends frontier-model tokens only on taste and delegates everything
else to cheap models and deterministic tools.

- MCP endpoint: `https://app.motion.digitop.ai/mcp` (Streamable HTTP, bearer API key)
- Site: https://motion.digitop.ai
- License: MIT

## How it works

```
brief ─▶ Jev routing ─▶ creative direction (host Opus or internal Opus) ─▶ Motion IR
     ─▶ deterministic compiler / Pi scene workers ─▶ HyperFrames lint · check · contact sheet
     ─▶ Jev issue classification ─▶ cheap fix  or  bounded Opus critique
     ─▶ preview render ─▶ final render ─▶ FFmpeg finishing ─▶ MP4
```

- **Claude Opus 5.5** is the creative director: concept, scene architecture, critique. It never writes HTML.
- **Director modes** are explicit: `host-opus` (the calling Claude supplies a `creativeSpec`, so Opus is
  not paid twice; supplying a spec selects this mode) or `internal-opus` (the server calls Opus via
  OpenRouter). A `custom` planner mode is reserved but not yet accepted.
- **Jev** makes bounded, structured routing decisions (TypeSafe → cheap LLM → rules).
- **Motion IR** is a renderer-neutral contract; HyperFrames is the first compiler target.
- **Pi** runs cheap coding models for custom scenes, fenced to the scene file it owns.

Details: [docs/README.md](docs/README.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Motion IR](docs/MOTION_IR.md) · [MCP API](docs/MCP_API.md) · [Decisions](docs/decisions/README.md)

## Connect a client

```json
{
  "mcpServers": {
    "motion": {
      "type": "http",
      "url": "https://app.motion.digitop.ai/mcp",
      "headers": { "Authorization": "Bearer mmcp_YOUR_API_KEY" }
    }
  }
}
```

Call `motion_inspect` first: it returns the director modes, the `CreativeSpec` JSON Schema and pricing.

## Develop

Requirements: Node ≥ 22.19, pnpm 10, FFmpeg on `PATH`. Chrome for rendering is fetched on demand.

```bash
pnpm install
cp .env.example .env
pnpm check        # lint + typecheck + unit tests (never calls paid models)
pnpm dev          # MCP server on http://localhost:8787/mcp
pnpm motion doctor
pnpm motion keys create --name laptop   # issue a workspace API key (printed once)
pnpm motion create --brief "30s launch video for a developer tool, editorial, restrained"
pnpm test:live    # optional: real OpenRouter / R2 calls, needs keys in .env
```

Docker: `docker compose up --build` (add `--profile tunnel` with `CLOUDFLARE_TUNNEL_TOKEN` for public ingress).

## Repository

| Path | Purpose |
|---|---|
| `apps/mcp-server` | Streamable HTTP MCP server and `motion` CLI |
| `apps/marketing` | Static site on Cloudflare Workers |
| `packages/motion-ir` | Motion IR, CreativeSpec, TastePacket, ScenePatch schemas |
| `packages/pipeline` | Execution graph, jobs, budgets |
| `packages/director` · `jev-router` · `llm` | Creative direction, routing, OpenRouter client |
| `packages/hyperframes-adapter` · `media` · `pi-runtime` | Rendering, FFmpeg/multix, Pi workers |
| `packages/domain-pack` | Motion knowledge adapted from ak-motion-video (MIT) |
| `packages/billing` · `storage` · `database` · `observability` · `shared` | Credits, artifacts, persistence, traces, utilities |

## Credits

Built on [HyperFrames](https://github.com/heygen-com/hyperframes), [Pi](https://github.com/earendil-works),
[multix](https://github.com/mrgoonie/multix-cli) and the ak-motion-video skill from
[bestagentkits](https://github.com/bestagentkits).
