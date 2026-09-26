# Jev Routing

Jev is the decision layer. It answers typed questions about where work should
go. It never writes code, prose or creative specs. The design is planned in
`packages/jev-router`, and the reasoning is in
[ADR 0004](decisions/0004-jev-decision-client.md).

Two things share the name "Jev", and only one of them is used here:

- **TypeSafe Jev** is a decision model behind TypeSafe's own
  `POST /v1/systemone` endpoint. It returns typed choice, score or probability
  answers. This is the one Motion MCP uses.
- **OpenRouter `typesafe/jev-router`** is a chat router that forwards requests
  to other models and advertises no structured-output support. It is not the
  decision API, and it must not be configured as a decision adapter.

## DecisionClient

```ts
interface DecisionClient {
  decide<Q extends QuestionSet>(state: DecisionState, questions: Q): Promise<Answers<Q>>;
}
```

`DecisionState` is a compact, redacted summary. It holds the issue, the scene
role, the attempts so far, the remaining budget and the director mode. It never
contains secrets or full HTML. Every answer is typed and carries the adapter
that produced it.

## Questions

| Question | Answer type | Asked when |
|---|---|---|
| `needs_opus` | probability (0–1) | Before the director, critique or polish stages run |
| `root_cause` | enum: `mechanical`, `asset`, `render`, `creative` | For each normalized QA issue |
| `cheap_fixable` | probability (0–1) | For `mechanical` or `asset` issues, before a Pi or media attempt |
| `worker` | enum: `pi`, `hyperframes`, `ffmpeg`, `asset`, `audio`, `vision`, `opus` | When choosing the executor for a fix |
| `render_justified` | probability (0–1) | Before any preview or final render |

The pipeline acts on each root cause as follows:

| Root cause | Action |
|---|---|
| `mechanical` | Pi patch, or a deterministic fix |
| `asset` | The media worker |
| `render` | A retry |
| `creative` | Opus critique, or a host critique request in `host-opus` mode |

## Adapters

The adapters form a chain. Each one either answers or hands off to the next,
and the rules adapter always answers.

| Order | Adapter | Enabled when | Notes |
|---|---|---|---|
| 1 | TypeSafe `systemone` | `TYPESAFE_API_KEY` is set | Uses `@typesafe-ai/sdk` with a configurable model id (`jev-latest`, or a pinned version). Input costs $0.042 per million tokens and output is free. Context is 64k per request. |
| 2 | OpenRouter structured output | `OPENROUTER_API_KEY` is set | Uses a cheap model with `response_format: json_schema` and `require_parameters: true`. The schema comes from the zod question set. The model id is configuration and must advertise `structured_outputs`. |
| 3 | Deterministic rules | Always | A pure function over the state. It is the CI path and is the answer whenever the other adapters fail or time out. |

These are the rules adapter's baseline rules:

| Situation | Decision |
|---|---|
| A valid host spec is present | `needs_opus = 0` |
| Lint or check findings of type overflow, contrast, clipping, safe area, collision or timing mismatch | `root_cause = mechanical` |
| A missing or failed asset reference | `root_cause = asset` |
| A render timeout or a transient spawn error | `root_cause = render` |
| An issue survives two cheap patches, or a critique acceptance criterion fails | `root_cause = creative` |
| A render is requested while lint errors are open | `render_justified = 0` |

## Thresholds

The thresholds are configuration defaults, which should be tuned using trace
data.

| Decision | Default rule |
|---|---|
| Escalate to Opus | `needs_opus ≥ 0.7`, and the job budget covers the stage estimate |
| Try the cheap path first | `cheap_fixable ≥ 0.5` |
| Render | `render_justified ≥ 0.6` for previews. The final render always requires lint and check to pass. |
| Adapter timeout | 3 s, then the next adapter is tried |

## Budgets

- Revision loops are capped per job (default 3).
- Opus critique calls are capped per job (default 2 scene batches).
- The caller sets `budgetCredits`. Before every paid step, the pipeline checks
  the step's estimate against the remaining reserved credits. When the
  remaining budget is too low, the job ends with `budget_exceeded` and returns
  its best valid version. It does not continue at the user's expense.
- Decision calls are counted in COGS. They are not billed as a separate credit
  line (see [BILLING.md](BILLING.md)).

## Tracing

Each decision writes a `jev.decide` span with these attributes:

- the question names;
- the adapter used, and the reason for any fallback;
- the model id;
- the answers and their probabilities;
- the threshold applied and the resulting action;
- latency, tokens in and cost.

Joining these spans with the job outcome, meaning whether a fix passed its gate
or not, is the evidence for tuning thresholds (see
[OBSERVABILITY.md](OBSERVABILITY.md)).
