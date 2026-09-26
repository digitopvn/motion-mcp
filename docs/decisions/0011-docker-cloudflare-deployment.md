# 0011. Docker Compose on a VPS behind a Cloudflare Tunnel

## Status

Accepted. Production verification depends on Docker access on the VPS.

## Context

Renders need Chrome headless shell, FFmpeg and a pinned font and runtime
environment. Deterministic output needs Linux, because capture on Windows and
macOS is screenshot-based. When this decision was made, the target VPS had
these properties:

- Debian, Node 22 and Chrome present;
- no FFmpeg;
- nothing listening on ports 80 or 443;
- a deploy user without Docker group access or passwordless sudo.

## Decision

- One Docker image serves the MCP server and pipeline. It contains Node 22,
  Chrome headless shell, FFmpeg and ImageMagick.
- **docker compose** on the VPS runs these services:
  - the app;
  - PostgreSQL with pgvector;
  - `cloudflared`.
- Public ingress goes through a **Cloudflare Tunnel** to
  `app.motion.digitop.ai`, with the MCP endpoint at `/mcp`. No inbound ports
  are opened.
- The marketing site `motion.digitop.ai` is deployed to **Cloudflare Workers
  static assets**.
- Artifacts are stored in Cloudflare R2
  ([ADR 0009](0009-persistence-repositories.md)).
- Deploy secrets come from GitHub Actions secrets.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Bare-metal Node with systemd | Chrome, fonts and FFmpeg versions drift, so renders stop being reproducible. |
| Kubernetes | Operational overhead with no benefit at a single-node scale. |
| Serverless rendering (Lambda or Cloud Run adapters) | A later option for burst capacity, not needed for v1. |
| Opening ports with a reverse proxy | The tunnel avoids exposing the host and handles TLS. |

## Reason

A single pinned image gives reproducible renders. The tunnel gives TLS and
ingress without any open ports on the VPS.

## Trade-offs

- Everything runs on a single node, so render capacity is bounded by one VPS.
- The deployment depends on Cloudflare for ingress.

## Migration strategy

`apps/render-worker` can be split into its own compose service, or its own
host, consuming the same jobs. Moving PostgreSQL to a managed service needs
only a connection-string change.
