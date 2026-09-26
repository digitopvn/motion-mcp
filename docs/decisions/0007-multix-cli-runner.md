# 0007. multix through our own CLI runner

## Status

Accepted.

## Context

`@mrgoonie/multix` (MIT) covers many providers for image, video, speech,
transcription, music, SFX and upscaling. It exposes no programmatic provider
API: its argv is the contract, and it has no global `--json` flag and no cost
output. It also has two security traps:

- It loads `<cwd>/.env` automatically.
- `multix check` prints key fragments.

pi-multix wraps multix for Pi agents, but it has three drawbacks here. It
forwards the whole `process.env` and raw output to the model, it returns text
only, and it depends on an older multix range.

## Decision

- `packages/media` runs the pinned `multix` CLI through `execFile` with argv
  arrays. It reuses pi-multix's per-provider argv tables and runner design, but
  it does not depend on pi-multix at runtime.
- Each run gets a scrubbed environment and a controlled `cwd`, as specified in
  [SECURITY.md](../SECURITY.md#multix-environment-scrubbing). Outputs are pinned
  with `--output`.
- Motion MCP maintains its own **static capability matrix**, mapping each
  capability to a provider and argv prefix, and its own **price table**, keyed
  by provider, model and unit. The runner records usage from the parameters it
  sends.
- FFmpeg transforms that multix lacks are implemented in the same package:
  tile, trim, concat, mux, loudnorm and faststart.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Use the pi-multix tools directly in Pi | Leaks environment variables and key fragments to the model, returns text-only results and has no cost data. |
| Import multix internals from `dist/` | The maintainers advise against it, and it breaks on refactors. |
| Write our own provider clients | This is the work multix already does. |

## Reason

A thin runner keeps full control over the environment, `cwd`, results and cost,
while reusing the provider coverage.

## Trade-offs

- Parsing stdout is fragile.
- The capability matrix and price table must be maintained by hand whenever
  multix or provider prices change.

## Migration strategy

Pin multix exactly and add contract tests on the `--help` output. If upstream
adds `--json` output or an exit-code taxonomy, the stdout parsing can be
replaced behind the runner interface.
