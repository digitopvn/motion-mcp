# 0005. HyperFrames hybrid library and CLI integration, pinned

## Status

Accepted.

## Context

HyperFrames (Apache-2.0) supplies the composition format, the linter, the
runtime checks, snapshots and the render pipeline. Some of this is exposed as
libraries:

- `@hyperframes/lint` for linting;
- `@hyperframes/producer`, whose `createRenderJob` and `executeRenderJob`
  handle rendering;
- `@hyperframes/core`.

`check`, `snapshot` and `keyframes` have no library export and are available
only through the CLI with `--json`. The project ships almost daily, so its APIs
change often. Telemetry is on by default.

## Decision

- Motion MCP generates the HTML itself, from the IR. It lints in-process with
  `@hyperframes/lint`, runs `hyperframes check`, `snapshot` and `keyframes` as
  subprocesses with `--json`, and renders with `@hyperframes/producer` inside
  the Linux image.
- All `@hyperframes/*` packages and the `hyperframes` CLI are pinned exactly to
  one version, **0.8.78**.
- Servers set `HYPERFRAMES_NO_TELEMETRY=1` and `HYPERFRAMES_NO_UPDATE_CHECK=1`,
  and call `snapshot` with `--describe false`.
- `packages/hyperframes-adapter` is the only package that touches HyperFrames.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| CLI only | It is stable, but it adds process overhead, and renders emit progress text rather than JSON. |
| Libraries only | Not possible, because `check` and `snapshot` have no library export. |
| HeyGen `cloud render` or the hosted HyperFrames MCP as the backend | Cloud-only, billed per credit, OAuth, with a 200 MB zip cap. It gives up self-hosted rendering, which is a differentiator. |

## Reason

The hybrid approach gives the most control at the lowest parsing cost, and each
capability uses the most stable surface available for it.

## Trade-offs

- Exact pins mean upgrades are deliberate work.
- The subprocess calls depend on the shape of the `--json` output.

## Migration strategy

To upgrade HyperFrames:

1. Bump the single pinned version.
2. Run the adapter's contract tests against the golden fixtures, covering
   lint, the `check` envelope, snapshot paths and a render.
3. Only then merge.

If upstream exports `checkPipeline`, the subprocess call can be replaced behind
the adapter interface.
