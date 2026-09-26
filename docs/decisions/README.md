# Architecture decision records

Each ADR records a single decision along with its context, the alternatives
considered, the trade-offs and a migration path. ADRs are append-only. To
change a decision, add a new ADR that supersedes the old one, and update the
old one's status line to point to it.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-pnpm-typescript-monorepo.md) | pnpm TypeScript monorepo (ESM, Node ≥ 22.19, vitest, biome) | Accepted |
| [0002](0002-renderer-neutral-motion-ir.md) | Renderer-neutral Motion IR, with zod as the source of truth and JSON Schema export | Accepted |
| [0003](0003-explicit-director-mode.md) | Explicit `DirectorMode` and the `motion_inspect` capability handshake | Accepted |
| [0004](0004-jev-decision-client.md) | Jev as a typed `DecisionClient` with TypeSafe, OpenRouter and rules adapters | Accepted |
| [0005](0005-hyperframes-hybrid-integration.md) | HyperFrames hybrid library and CLI integration, pinned to 0.8.78, telemetry off | Accepted |
| [0006](0006-pi-embedded-runtime.md) | Pi embedded in-process (0.87.1) with a submit tool, path guard, container isolation and a compiler floor | Accepted |
| [0007](0007-multix-cli-runner.md) | multix through our own CLI runner, with a scrubbed environment, capability matrix and price table | Accepted |
| [0008](0008-stateless-streamable-http-mcp.md) | Stateless Streamable HTTP MCP (SDK v2 2.1.0) with job polling | Accepted |
| [0009](0009-persistence-repositories.md) | Repository interfaces, a file-backed store, PostgreSQL (drizzle) and R2 artifacts | Accepted |
| [0010](0010-credit-ledger-billing.md) | An internal credit ledger (1 credit = $0.01), with Polar for top-ups and subscriptions only | Accepted |
| [0011](0011-docker-cloudflare-deployment.md) | Docker Compose on a VPS behind a Cloudflare Tunnel, and marketing on Workers static assets | Accepted |
| [0012](0012-domain-pack-lift-and-wrap.md) | Domain pack: lift and wrap ak-motion-video, with tag retrieval and brand aliases off by default | Accepted |
