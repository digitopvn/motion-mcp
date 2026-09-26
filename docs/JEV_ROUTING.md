# Jev Routing

Jev is the decision layer. It answers typed questions about where work should
go. It never writes code, prose or creative specs. The code is
`packages/jev-router`, and the reasoning is in
[ADR 0004](decisions/0004-jev-decision-client.md).

Two things share the name "Jev", and only one of them is used here:

- **TypeSafe Jev** is a decision model behind TypeSafe's own
  `POST /v1/systemone` endpoint. It returns typed choice, score or probability
  answers. This is the one Motion MCP uses.
- **OpenRouter `typesafe/jev-router`** is a chat router that forwards requests
  to other models and advertises no structured-output support. It is not the
  decision API, and the LLM adapter refuses it as a decision model.

## DecisionClient

`DecisionClient.decide(question, span)` answers **one question per call**. A
question is a `choice` (pick one option key), a `yesno` (a 0–1 probability) or a
`score` (a position on ordered levels, normalized to 0–1). Every question
carries its own deterministic `rule`, which is what the rules adapter answers,
and a compact, redacted `state` that never contains secrets or full HTML. The
types are in `packages/jev-router/src/decision-types.ts`.

Asking one question per call keeps each answer independently typed, validated
and traced, and lets a cheap adapter fail on one question without losing the
others.

## Adapter chain

`createDecisionClient` builds the chain, and `DecisionChain` runs it. Each
adapter either returns a valid answer or falls through to the next; the rules
adapter always answers.

| Order | Adapter | Enabled when | Model setting |
|---|---|---|---|
| 1 | TypeSafe `systemone` | `TYPESAFE_API_KEY` is set | `JEV_MODEL` (default `jev-latest`) |
| 2 | LLM structured output through OpenRouter | The server has an OpenRouter gateway (`OPENROUTER_API_KEY`) | `DECISION_MODEL` |
| 3 | Deterministic rules | Always | None |

- Network adapters get a per-adapter timeout (3 s by default). The rules
  adapter is never timed out.
- An answer that is not one of the declared options, or not a number in 0–1,
  counts as a failure and falls through.
- Fall-through reasons are recorded on the decision and on its span.
- Tests and CI run a rules-only chain, so they make no model calls.

## What is decided, and how

The policies are pure functions in `packages/jev-router/src/router-policy.ts`.

| Decision | How it is made |
|---|---|
| Is a director call needed? | `routeIntent`: a supplied `creativeSpec` means no internal director. No model is asked. |
| Classify a QA issue | Issues in the mechanical `QaCategory` set are classified by rules with no model call (`jev.shortcircuit`). Other issues ask the chain `root_cause` (a choice over the `ROOT_CAUSES` list) and then `cheap_fixable` (yes/no). |
| Cheap fix or creative judgment | An issue is cheap-fixable while it has had fewer than two failed cheap attempts and, for model-classified issues, `cheap_fixable ≥ 0.5`. An issue that is not cheap-fixable and whose root cause creative judgment can fix is marked `needsOpus`. Asset, render and audio causes never go to Opus. |
| Escalate a scene to critique | `shouldEscalateToOpus`, below. |
| Render | `isRenderJustified`: a final render needs zero lint errors, zero check errors, no open deterministic error findings, and enough remaining budget. |

The pipeline acts on the classification in the revision loop
(`packages/pipeline/src/build-version.ts`): cheap fixes become an IR patch when
the change is expressible, and a Pi patch otherwise; creative issues become a
director critique, or a host critique request in `host-opus` mode.

## Budgets and caps

| Cap | Value | Owner |
|---|---|---|
| Revision loops per job | `MAX_REVISION_LOOPS`, default 2 (maximum 5) | `packages/shared/src/config.ts` |
| Critiques per scene per job | 1 | `DEFAULT_CRITIQUE_LIMITS` |
| Critiques per job | 2 | `DEFAULT_CRITIQUE_LIMITS` |
| Cheap attempts before escalation | 2 | `MAX_CHEAP_ATTEMPTS` |

- An internal critique runs only when the job's remaining budget covers its
  estimated cost (8k input and 2k output tokens, priced at the director model's
  rate). Host critiques cost the platform nothing, so they skip this check.
- The job's budget is the caller's `budgetCredits`, or the reservation when no
  budget is given. How reservations are sized is in [BILLING.md](BILLING.md).
- Decision calls are counted in COGS. They are not billed as a separate credit
  line.
- The thresholds are code defaults, to be tuned against trace data.

## Tracing

Every decision, including the rules short-circuit, writes a `jev.route` span.
Its attributes (`jev.question`, `jev.adapter`, `jev.model`, `jev.answer`,
`jev.confidence`, `jev.latency_ms`, `jev.fallbacks`) are set in
`packages/jev-router/src/decision-chain.ts` and `router-policy.ts`. Model usage
from the TypeSafe and LLM adapters is recorded on the span as a model call.

The revision loop also records each critique verdict and its reason as a
`critique.<sceneId>` attribute on the job span. Joining these with the job
outcome, meaning whether a fix passed its gate, is the evidence for tuning the
thresholds (see [OBSERVABILITY.md](OBSERVABILITY.md)).
