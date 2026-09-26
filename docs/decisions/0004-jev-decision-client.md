# 0004. Jev as a typed DecisionClient with adapters

## Status

Accepted.

## Context

The pipeline needs cheap, bounded decisions:

- whether to escalate to Opus;
- the root cause of an issue;
- whether a cheap fix is likely to work;
- which worker should act;
- whether a render is justified.

TypeSafe's Jev is a decision model. It uses TypeSafe's own `POST /v1/systemone`
endpoint with typed choice, score and probability answers. Input costs $0.042
per million tokens, output is free, and there is no chat or code generation.
On OpenRouter, the only related listing is `typesafe/jev-router`, which is a
chat router that forwards to other models. It advertises no tools or structured
outputs, and it is **not** the decision API. No TypeSafe key was available when
this decision was made.

## Decision

- `packages/jev-router` exposes a `DecisionClient` interface that returns typed
  answers. The details are in [JEV_ROUTING.md](../JEV_ROUTING.md).
- The adapters are tried in order:
  1. TypeSafe `systemone`, when `TYPESAFE_API_KEY` is set.
  2. OpenRouter structured output with a configurable cheap model.
  3. Deterministic rules, which always answer and serve as the CI path.
- Every decision is traced with the adapter used, the answers and the cost.
- `typesafe/jev-router` is not used as a decision adapter.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Use `typesafe/jev-router` via OpenRouter | It is a chat router, the routing pool is unpublished, and structured outputs are not advertised. |
| Hard-coded rules only | Too coarse for creative-versus-mechanical calls, and the rules cannot learn from traces. |
| Ask Opus to route | That spends frontier tokens on the decision meant to avoid frontier tokens. |
| Hard dependency on TypeSafe | There is no key yet, and a single vendor would block the slice. |

## Reason

A typed interface keeps routing testable and swappable. The rules adapter
guarantees an answer without any network access.

## Trade-offs

- Three adapters must stay behaviorally aligned, so thresholds are tuned per
  adapter.
- The OpenRouter adapter costs more than TypeSafe per decision.

## Migration strategy

When a TypeSafe key becomes available, setting `TYPESAFE_API_KEY` makes it the
primary adapter with no code change. New questions are added to the question
set together with a rules fallback.
