# Observability

Every job writes a single hierarchical trace, and every paid step in that trace
records its cost. Neither multix nor HyperFrames reports costs, so Motion MCP
computes them from its own price tables. The span model is
`packages/observability/src/tracer.ts`, which is the authority for field names.

## Traces

- Each job has one root span, `video.create`, `video.edit` or `video.render`,
  carrying the job, project and workspace ids and the director mode.
- Child spans follow the [execution graph](ARCHITECTURE.md#execution-graph):
  director calls (`director.spec`, `director.host_spec`, `director.critique`,
  `director.edit`), `scenes.build`, the Pi scene spans, `hyperframes.lint`,
  `hyperframes.check`, `snapshot.contact_sheet`, vision QA, one `jev.route` per
  decision, `artifacts.store` and the renders. The call sites in
  `packages/pipeline/src` are the authority for names.
- Each span has an id, parent, name, start and end time, status, redacted error,
  attributes, retry count, model calls and costs, so the shape maps directly
  onto OpenTelemetry.

## Cost fields

| Field | On | Source |
|---|---|---|
| Model calls: model, provider, input, output, cache-read and cache-write tokens, cost | Any span that calls a model | The provider's reported cost when present (OpenRouter `usage.cost`, Pi message usage), otherwise tokens × the price list in `packages/llm` |
| `costs.api` | Spans with model calls | Sum of their model-call costs |
| `costs.render` | Render spans | The estimated cost of goods for the render line in the billing price table (per preview, or per output minute) |
| `costs.asset` | Media spans | The media price table in `packages/media`, once asset generation is wired in |
| `costs.storage` | Reserved | **Planned** |

`summarize()` rolls a trace up into totals: duration, tokens, API, render, asset
and storage cost, COGS, retries, failures, model calls, Opus calls, and cost by
model and by provider. Costs are held in USD as floating-point numbers on each
span and summed per trace.

## Where traces go

- When a job ends, successfully or not, its trace is redacted with the shared
  redactor and saved with its summary through the trace repository (a JSON file
  under `DATA_DIR` today). The job's cost and captured credits are also stored
  on the job.
- `motion_get_project` with `include: ["trace"]` returns a redacted text tree
  and summary. `pnpm motion create` and `render` print the same tree.
- The server logs a one-line `job.finished` event with the rendered tree.

**Planned:**

- OTLP export, with OTel GenAI semantic-convention names
  (`gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`) alongside `motion.*` fields. The GenAI
  conventions are still experimental, so the `motion.*` fields are the ones to
  rely on.
- PostgreSQL `traces`, `spans` and `model_calls` tables as the queryable sink
  (already defined in the drizzle schema).
- Revenue, gross profit and gross margin written on the root span. The
  `margin()` helper computes them today, but nothing persists them per span.
- Integer USD micros for stored cost fields, so sums stay exact at scale.

## Dashboard metrics

**Planned** with the dashboard. These are the metrics the traces are meant to
support:

| Metric | Why it matters |
|---|---|
| COGS, revenue and gross margin per video, per operation and per director mode | The margin term of the [success metric](PRODUCT.md#success-metric) |
| Brief-to-MP4 latency (p50/p95), and latency per stage | The latency term |
| Jobs that reach a final MP4 without human intervention, and jobs that end in `budget_exceeded` | The reliability term |
| First-pass lint and check pass rate, split by compiler and Pi, and the worker reversion rate | Whether the build tiers are healthy |
| Revision loops per job, and the patches needed per issue class | Routing quality |
| Opus escalation rate, and the host-mode critique rate | Taste spend |
| Jev adapter mix, and how often decisions fall back | Decision-layer health |
| Prompt cache-read ratio for director calls | Cost rule 12 |
| Render seconds per output second, per quality | Render efficiency |
| Provider error rate by provider and model | Media and model reliability |
| Credit burn and balance by workspace | Billing health |
