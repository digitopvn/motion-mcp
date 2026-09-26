# Phase 03: LLM client, Director and Jev router

Status: done. My three packages typecheck, lint and test clean. The repo-wide `pnpm typecheck` and `pnpm lint` still fail, and every failure is in a file owned by another agent (details below).

## What I built

### `@motion-mcp/llm`
- **`OpenRouterClient`** uses native `fetch` and implements the `ModelGateway` interface.
  - `chat({ model, messages, responseSchema?, maxTokens, temperature, cache?, signal, span? })` returns `{ text, parsed?, usage, calls }`.
  - Every request sends `usage: { include: true }`. Structured requests use `response_format: json_schema` with `strict: false`, plus `provider: { require_parameters: true }`.
  - Retries cover 408, 429 and 5xx responses and network errors. Backoff is exponential with jitter and honours `Retry-After`.
  - Each attempt has its own timeout and respects the caller's abort signal.
  - Errors surface as `MotionError("PROVIDER")`. The message and response body are redacted, and the API key is registered as a secret.
  - Images must be `data:image/...` or `https` URLs.
  - On `anthropic/*` models, `cache_control: ephemeral` is added to the last text block of the system message and to any part marked `cache: true`.
- **`chat(gateway, opts)`** does the zod parsing. It tolerates code fences and runs a bounded repair loop (default 1, maximum 2) that sends the validation issues back to the model. If the repair also fails it throws `MotionError("PROVIDER", { reason: "invalid_structured_output" })`. Every call is recorded with `span.recordModelCall`.
- **Schema transport (new; the live test showed it was needed).** Anthropic rejected the CreativeSpec schema twice:
  - it does not support `oneOf`;
  - it allows at most 24 optional parameters, and CreativeSpec has 135.

  I made two changes:
  - `toResponseJsonSchema` now produces a schema every provider accepts: `oneOf` becomes `anyOf`, objects are closed, and value constraints move into description text. zod still enforces the full schema on the reply.
  - `schemaTransport: "auto"` (the default) tries `json_schema` first. If the provider rejects the schema itself (a 400 mentioning schema or grammar), it retries once with the schema placed in the cached system prompt. It then remembers that model for the rest of the process.
- **Pricing.** `PRICES` holds prices for the six default models, taken from the public OpenRouter `/models` endpoint on 2026-09-26. `estimateCost` covers cache reads and writes and returns `undefined` for unknown models. The client uses the API's `usage.cost` whenever it is present.
- **`ScriptedGateway`** replays fixture replies with no network access, for tests and CI.

### `@motion-mcp/director`
- **`resolveDirectorMode`** uses explicit signals only, in this order:
  1. the requested mode;
  2. a supplied `creativeSpec`, which counts as an explicit host-direction payload and resolves to host-opus;
  3. the workspace default.

  It raises `VALIDATION` with guidance for `host-opus` without a spec, and for a spec combined with an explicit `internal-opus` or `custom` mode. It never looks at model or client names.
- **`Director`** is a class holding the gateway and `directorModel`.
  - `createCreativeSpec(input, span)`:
    - `host-opus` validates the supplied spec and makes zero model calls.
    - `internal-opus` and `custom` make one structured call, and `custom` requires `customModel`.
    - Domain, taste and recipe snippets are capped at 8 × 1,500 characters and sent as a cached block. An explicit caller format overrides the model's choice.
    - The spec schema adds checks for unique scene and element ids and for choreography references, so these errors are caught during repair.
  - `critiqueScene(bundle, span, { mode })` returns a `ScenePatch` with `source: "opus"`, pinned to the bundle's scene. Change targets must be elements of that scene, and a violation triggers a repair. Local frame files become data URLs (maximum 8 MB). `host-opus` is refused.
- **Critique bundles.**
  - `buildSceneCritiqueBundle(ir, sceneId, artifacts, taste)` includes only the target scene's IR and QA issues, the taste subset, and neighbouring transition kinds and boundary frames.
  - `buildHostCritiqueRequest(bundle)` returns `{ requestId: crq_…, instructions, bundle, responseSchema, respondWith }` without making a model call.
- **Prompts.** `DIRECTOR_SYSTEM_PROMPT`, `CRITIC_SYSTEM_PROMPT` and `promptGuidance()` (for the capability handshake) take their IR vocabulary from the zod enums, so they cannot drift from the schemas.

### `@motion-mcp/jev-router`
- **Question types.** There are three: `choice`, `yesno` and `score`. Each question carries its own deterministic `rule`.
- **`decide`.** The signature is `decide<Q>(question, span): Decision<AnswerOf<Q>>`. I used this instead of the literal `DecisionQuestion<T>` in the phase file because it gives sound answer types.
- **`DecisionChain`** applies a per-adapter timeout (default 3 s) and validates answers: choices must be among the declared options and numbers must be 0–1. Each decision writes a `jev.route` span with the question, adapter, model, answer, confidence, latency and fallback reasons.
- **Adapters.** `TypeSafeJevClient`, `LlmDecisionClient` and `RuleDecisionClient`.
  - `TypeSafeJevClient` follows the request and response shape in `docs.typesafe.ai/api.md` (read 2026-09-26). It sends `POST /v1/systemone` with body `{ model, state: <redacted JSON string>, questions: { id: { type, instructions, criteria } } }`. `yesno` maps to `noul`, and a `score` answer is normalized by `(levels − 1)`. Usage is priced at $0.042 per million input tokens.
  - `LlmDecisionClient` refuses `typesafe/jev-router`.
- **`createDecisionClient(config, { gateway?, fetch?, timeoutMs? })`** builds the chain TypeSafe (only if `TYPESAFE_API_KEY` is set) → LLM (only if a gateway is given) → rules.
- **Policies:**
  - `routeIntent`.
  - `classifyIssue`: the mechanical categories resolve by rules with no model call. A layout, typography, timing or implementation issue that survives two cheap attempts escalates to Opus without asking a model. Creative issues ask `root_cause` and `cheap_fixable`.
  - `shouldEscalateToOpus`: caps of 1 critique per scene, 2 per job and a loop limit. The budget must be at least the critique estimate (8k in / 2k out tokens; unknown models are priced as Opus). Host mode skips the budget check.
  - Also `isRenderJustified`, `shouldRetry`, `selectModel` and `estimateCritiqueCostUsd`.

## Prompt sizes
| Block | Characters | Approximate tokens |
|---|---|---|
| Director system prompt | 3,098 | ~0.8k |
| CreativeSpec schema (prompt transport) | 17,426 | ~4.5k |
| Critic system prompt | 2,343 | ~0.6k |
| ScenePatch schema | 1,892 | ~0.5k |

In the live call, the whole prompt was 8,927 input tokens, and 8,751 of them were cache reads on a repeat call.

## Tests
- `pnpm vitest run --project unit packages/llm packages/director packages/jev-router`: 35 of 35 pass.
- Full `pnpm test`: 165 of 165 pass across 18 files.
- `pnpm typecheck` fails only in `packages/pi-runtime/test/pi-worker.test.ts:25`, which another agent owns.
- `pnpm lint` fails only on formatting of files outside my scope: `apps/mcp-server/*`, `packages/hyperframes-adapter/tmp/*`, fixtures, root configs and `.claude/settings.local.json`. `biome check` on my three packages is clean.
- Live test (`packages/director/test/director.live.test.ts`) passes with `anthropic/claude-opus-5.5`:
  - 1 call, 8,927 input tokens (8,751 cache reads) and 2,669 output tokens;
  - **$0.0553**, producing 5 scenes totalling 20 s that compile into a valid MotionIR.
  - Total live spend this session was about $0.16. That is two successful calls, one of which paid for the cache write, plus two schema rejections, which were not billed.

## Open issues
1. **Output budget.** The director output was 2,669 tokens, slightly over the 2.5k target. `maxTokens` is capped at 4,096.
2. **Docs differ from code.** `docs/JEV_ROUTING.md` uses the span name `jev.decide` and the signature `decide(state, questions)`. The code follows the phase file, with the span `jev.route` and one question per call. The docs also say the mode falls back to "workspace default then internal-opus". The code also treats a supplied `creativeSpec` as an explicit host-opus signal. The docs agent should reconcile these.
3. **TypeSafe `noul` criteria keys.** The TypeSafe docs conflict: the API reference uses `true`/`false` and the primitives page uses `yes`/`no`. I used `true`/`false`. This is untested against the live API because no `TYPESAFE_API_KEY` is set.
4. **Schema-rejection memory.** The memory is per process, so each new process makes one rejected `json_schema` request per Anthropic model. That request is unbilled but adds about 1–2 s.
5. **Phase file not updated.** The file ownership I was given covered only the three packages, so I did not edit the plan or phase status.
