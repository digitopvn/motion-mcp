# Phase 03 — LLM client, Director, Jev router

## Context
Read `packages/motion-ir/src/*`, `packages/observability/src/tracer.ts`, `packages/shared/src/*`, `plans/reports/architecture-260926-2229-synthesis.md`, `plans/reports/researcher-260926-2229-pi-jev-mcp.md` (OpenRouter structured outputs, Jev facts). Docs being written in parallel: `docs/DIRECTOR_PROTOCOL.md`, `docs/JEV_ROUTING.md` (read if present; code is authoritative).

## Files owned
`packages/llm/**`, `packages/director/**`, `packages/jev-router/**`.

## Requirements
### packages/llm
- `OpenRouterClient` (native `fetch`, no SDK): `chat({ model, messages, responseSchema?: {name, schema(zod)}, maxTokens, temperature, cache? , signal })` → `{ text, parsed?, usage: ModelUsage }`. Structured output uses `response_format: { type: "json_schema", json_schema: { name, strict: false, schema } }` + `provider: { require_parameters: true }`, with `usage: { include: true }` so cost comes back; parse with zod, one repair retry on invalid JSON (send validation errors back, bounded). Supports image inputs (data URLs) for vision. Prompt caching: mark the stable system block with `cache_control: { type: "ephemeral" }` for Anthropic models. Retries with backoff on 429/5xx. Never log keys; errors are redacted `MotionError("PROVIDER")`.
- A static `PRICES` fallback table for models used by default (per-M in/out) used when the API does not return cost; `estimateCost(model, usage)`.
- `ModelGateway` interface so tests can inject a scripted fake (fixtures, not network). Live tests (`*.live.test.ts`) may call OpenRouter when `OPENROUTER_API_KEY` is set; unit tests must never hit the network.

### packages/director
- `DirectorMode = "host-opus" | "internal-opus" | "custom"`.
- `resolveDirectorMode({ requested?, creativeSpecProvided, workspaceDefault })`: explicit only — `host-opus` requires a creativeSpec (error otherwise with guidance); `internal-opus` ignores none; never infers from model names.
- `createCreativeSpec({ brief, format?, recipe?, tasteContext?, domainContext?, mode, customModel? }, span)`: internal-opus/custom → one structured call (Stage 1+2 combined) returning `CreativeSpec`; host-opus → validate the supplied spec, return it with zero model calls. System prompt: concise, cached, teaches the IR vocabulary (roles, element kinds, primitives, tokens), taste rules, anti-slop list, "do not write code", scene count/duration guidance, output budget (target < 2.5k output tokens). Include retrieved domain-pack/taste snippets only as passed in (strings), never whole documents.
- `critiqueScene(bundle, span)` (Stage 3/4): input is a minimal `SceneCritiqueBundle` { globalIntent, tastePacket (subset), tasteConstraints[], sceneIR, prevFrame?, contactSheet (image path/data URL), nextFrame?, qaDiagnosis[] } → `ScenePatch` (source "opus"). Build the bundle with `buildSceneCritiqueBundle(ir, sceneId, artifacts, taste)` — scene isolation: never includes other scenes' IR.
- Host mode helper `buildHostCritiqueRequest(bundle)` → a JSON payload the MCP returns to the host so the host's own Opus writes the patch (no internal call).
- Traces: every model call recorded on the span with `recordModelCall`.

### packages/jev-router
- `DecisionClient` interface: `decide<T>(question: DecisionQuestion<T>, span) → Decision<T>` where questions are typed: `choice` (enum options), `yesno` (probability), `score` (0–1). Adapters: `TypeSafeJevClient` (POST `${TYPESAFE_BASE_URL}/v1/systemone` with `{model, state, questions}`; implement against the documented shape in the research report; only enabled when `TYPESAFE_API_KEY` is set), `LlmDecisionClient` (OpenRouter cheap model with a json_schema answer), `RuleDecisionClient` (deterministic). `createDecisionClient(config)` builds a chain: TypeSafe → LLM → rules, falling through on error.
- `Router` policy functions (pure + decision-backed):
  - `routeIntent(brief, hasCreativeSpec)` → director needed or not.
  - `classifyIssue(issue, context)` → `{ rootCause: creative_direction|implementation|asset_quality|animation|timing|typography|layout|render_bug|audio|user_intent_mismatch, cheapFixable: boolean, worker: pi|hyperframes|ffmpeg|asset|audio|vision|opus, needsOpus: boolean, confidence }`. Mechanical categories (MECHANICAL_CATEGORIES) short-circuit via rules without any model call.
  - `shouldEscalateToOpus({ issues, loop, budgetRemainingUsd, mode })`, `isRenderJustified(...)`, `shouldRetry(...)`, `selectModel(task)` (returns configured model ids from config: DIRECTOR_MODEL, CODER_MODEL, DECISION_MODEL, VISION_MODEL).
  - Budgets: never escalate when remaining budget < estimated Opus critique cost; max one Opus critique per scene per job and a global cap.
- All decisions traced (`jev.route` spans with question, answer, adapter, latency).

## Tests
- Director: host-opus with a valid spec makes zero model calls; host-opus without spec errors; internal-opus with a scripted `ModelGateway` returns a valid spec and records usage; invalid model JSON triggers one repair then a typed error; critique bundle contains only the target scene.
- Jev: mechanical issues never call a model; creative issues escalate only within budget; adapter fallback order; `TypeSafeJevClient` request shape (use a local fake `fetch`).
- Live (optional, `*.live.test.ts`): real OpenRouter call with the product-launch brief using the director model, asserting schema validity and recording cost.

## Validation
`pnpm typecheck`, `pnpm lint`, `pnpm test` green.
