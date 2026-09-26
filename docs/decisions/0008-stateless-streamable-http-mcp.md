# 0008. Stateless Streamable HTTP MCP with job polling

## Status

Accepted.

## Context

Generating a video takes minutes. The MCP TypeScript SDK v2
(`@modelcontextprotocol/server` 2.1.0) implements the stateless spec. Its
`createMcpHandler` builds a fresh server per request, keeps no
`Mcp-Session-Id`, and serves 2025-era clients statelessly by default. The v1
`@modelcontextprotocol/sdk` is in maintenance.

## Decision

- Build `apps/mcp-server` on SDK v2 `createMcpHandler`, using Streamable HTTP
  at `/mcp`.
- Use `@modelcontextprotocol/express` for bearer auth and for the `allowedHosts`
  guard against DNS rebinding.
- Long work returns a `jobId` immediately, and clients poll
  `motion_get_project`.
- The public surface is exactly eight tools ([MCP_API.md](../MCP_API.md)).
- Tests drive the handler in-process with the SDK client and no network port.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Stateful sessions (`NodeStreamableHTTPServerTransport` with a session map) | Needs sticky routing and session storage for no benefit, because job state lives in the store. |
| Holding the tool call open until the video is done | Hits client timeouts and does not survive a restart. |
| Progress notifications or resumable streams | Client support varies. Polling works with every client. |
| SDK v1 | It is the maintenance line. |

## Reason

A stateless design scales horizontally behind the tunnel and survives restarts,
because all state is in the job store. It is also the SDK's recommended
default.

## Trade-offs

- Clients must poll.
- The latency of each progress update is bounded by the polling interval.

## Migration strategy

Progress notifications can be added later as an optional extra without changing
the tool contracts. OAuth (MCP authorization with resource metadata) can
replace or supplement API keys behind the same verifier interface.
