# Motion MCP documentation

Motion MCP is an open-source (MIT) motion-video production runtime served as an
MCP server. These documents record the v0.1 design and the decisions behind it.

The v0.1 vertical slice is implemented: the packages under `packages/`, the MCP
server and `motion` CLI in `apps/mcp-server`, the marketing site in
`apps/marketing`, and the Docker and GitHub Actions deployment files. The code,
tests and zod schemas are the authority for *what* the system does and *how*.
These docs keep the *why* and the *where*. A doc that disagrees with the code is
a bug in the doc. Parts that are still design only are marked **planned**, and
[ROADMAP.md](ROADMAP.md) tracks them.

## Start here

| Document | Read it when you need |
|---|---|
| [PRODUCT.md](PRODUCT.md) | The objective, users, director modes, non-goals, the success metric and the cost rules |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Package boundaries, the execution graph, persistence, configuration and deployment |
| [ROADMAP.md](ROADMAP.md) | Phase status, acceptance criteria and the V1 vertical slice |

## Contracts

| Document | Covers |
|---|---|
| [MOTION_IR.md](MOTION_IR.md) | Why Motion IR, `TastePacket`, `CreativeSpec` and `ScenePatch` look the way they do, and where their schemas live |
| [MCP_API.md](MCP_API.md) | The eight public tools, the HTTP routes, the `motion` CLI, auth, job polling and error codes |
| [DIRECTOR_PROTOCOL.md](DIRECTOR_PROTOCOL.md) | Director modes, the `motion_inspect` handshake, critique bundles and host critique requests |

## Subsystems

| Document | Covers |
|---|---|
| [AGENT_RUNTIME.md](AGENT_RUNTIME.md) | Pi as the scene worker: session, tools, submit tool, path guard and isolation |
| [JEV_ROUTING.md](JEV_ROUTING.md) | The typed decision layer: questions, the adapter chain, escalation caps and tracing |
| [SEARCH.md](SEARCH.md) | Current search, and the planned hybrid search and Taste Memory |
| [BILLING.md](BILLING.md) | Credits, reservations, the ledger, trial credits, Polar and BYOK |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Traces, cost fields and the planned exporters and dashboard metrics |
| [SECURITY.md](SECURITY.md) | Secrets, redaction, MCP auth, signed artifact URLs, isolation and DNS rebinding |

## Decisions

The architecture decision records are listed in
[decisions/README.md](decisions/README.md). An ADR records a decision and the
reasons for it. Superseding a decision means adding a new ADR, not rewriting the
old one. Where the shipped code does not yet meet an accepted decision, the
subsystem doc names the gap.

## Evidence

The research and implementation reports behind these decisions are kept under
`plans/reports/`. They are dated snapshots, so they may age. They are not
authority for current behavior.
