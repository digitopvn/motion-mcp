# Director Protocol

The director supplies taste. It turns a brief into a `CreativeSpec` and judges
creative issues. It never writes renderer code. The code is
`packages/director`, and the schemas it produces are described in
[MOTION_IR.md](MOTION_IR.md).

## DirectorMode

| Mode | Who writes the `CreativeSpec` | Who critiques creative issues |
|---|---|---|
| `host-opus` | The calling host model, which passes `creativeSpec` to `motion_create`. The server makes no director call and bills none. | The host. The pipeline pauses and returns a critique request. |
| `internal-opus` | `DIRECTOR_MODEL` through OpenRouter (default `anthropic/claude-opus-5.5`). Requires `OPENROUTER_API_KEY`. | The same model. |
| `custom` | **Planned:** a planner model the workspace configures, which must support structured outputs. The server rejects `custom` today because no workspace model can be configured yet. | The same model. |

`resolveDirectorMode` in `packages/director/src/director-mode.ts` uses explicit
signals only, in this order:

1. the `directorMode` argument of the call;
2. a supplied `creativeSpec`, which is itself an explicit host-direction
   payload, so it selects `host-opus`;
3. the server default, `DEFAULT_DIRECTOR_MODE` (default `internal-opus`).

`host-opus` without a spec, and a spec combined with an explicit
`internal-opus` or `custom`, are rejected with guidance instead of guessed at.
The server never infers the mode from the MCP client name, the model name or
the user agent ([ADR 0003](decisions/0003-explicit-director-mode.md)). The
resolved mode is returned by `motion_create`, stored on the project, and
recorded on the trace. `motion_edit` uses its own `directorMode` argument or
the project's mode.

## Handshake

A host that wants to direct calls `motion_inspect({ target: "capabilities" })`
before `motion_create`. The response is built in
`packages/pipeline/src/motion-service.ts` and contains, among other fields:

- `serverVersion`, `irVersion`, `defaultDirectorMode`, and whether the internal
  director is available on this server;
- `directorModes`, with what each mode requires;
- `creativeSpecSchema` and `scenePatchSchema`, the JSON Schemas exported from
  the zod types;
- `promptGuidance`, the same creative rules the internal director follows,
  generated from the zod enums so it cannot drift from the schemas;
- `formats`, `qualityPresets`, `pricing` (from the billing price table) and
  `limits`.

The host then writes a spec that validates against `creativeSpecSchema` and
calls `motion_create` with it. A spec that fails validation returns
`invalid_input` with the zod issues before any job, reservation or model call,
so the host can correct it at no cost. The same schemas are available locally
with `pnpm motion schema`.

## Stages

| Stage | Purpose | Input | Output | Status |
|---|---|---|---|---|
| 1+2 Direction and architecture (one call) | Taste and scene structure | The brief, the requested format, and cached context snippets from the domain pack (and a recipe, when supported) | `CreativeSpec` | Implemented (`Director.createCreativeSpec`) |
| 3 Critique | Judge the creative issues routed to it | One scene-isolated critique bundle (below) with the scene's contact sheet and boundary frames | One `ScenePatch` for that scene | Implemented (`Director.critiqueScene`) |
| 4 Polish | An optional final pass on an accepted cut | A contact sheet of the whole video, the `TastePacket` and an IR summary | Timing, typography, color and transition changes | **Planned** |

- Stages 1 and 2 are defined separately but run as one structured-output call,
  so the brief and domain context are paid for once.
- Critique runs only for issues Jev marks `needsOpus`, within the caps in
  [JEV_ROUTING.md](JEV_ROUTING.md#budgets-and-caps).
- Every output is validated with zod. On failure, the structured-output helper
  in `packages/llm` sends the validation issues back for a bounded repair. If
  repair also fails, the step fails with a typed provider error.
- A free-text `motion_edit` instruction in `internal-opus` mode is interpreted
  by the director into patches (`director.edit` span).
- Token limits, snippet caps and the brief limit are constants in
  `packages/director/src/director.ts`.

## Scene-isolation critique bundle

A critique covers one scene and never the whole project.
`buildSceneCritiqueBundle` in `packages/director/src/critique-bundle.ts` builds
it from:

- the scene's IR, including its `acceptance`, `constraints` and
  `antiPatterns`;
- a subset of the `TastePacket` and the taste constraints;
- the scene's contact sheet, plus only the last frame of the previous scene and
  the first frame of the next one;
- the QA issues for that scene only;
- the transition kinds at its boundaries. The neighbouring scenes' IR is never
  included.

Isolation keeps both the tokens and the blast radius small. The response schema
only accepts changes that target elements of that scene.

## Host-mode critique requests

In `host-opus` mode the pipeline never calls a director model. When a creative
issue passes the escalation policy:

1. The version is stored and the job moves to `awaiting_host`. The job's usage
   is captured at that point, so waiting costs nothing.
2. `motion_get_project` returns `critiqueRequest`, built by
   `buildHostCritiqueRequest`: a `crq_` request id, the scene id, the critic
   instructions, the bundle with its frames as signed URLs, the `ScenePatch`
   response schema, and a `respondWith` hint.
3. The host answers with `motion_edit({ projectId, critiqueRequestId,
   scenePatches })`, with patches for that scene only. This closes the waiting
   job and starts an edit job that produces the next version.

If the host never answers, the job stays in `awaiting_host`. The host can still
render the stored version with `motion_render`.

## Prompt caching

Prompts are assembled so that the most stable parts come first: the system
prompt, then the cached context block (domain-pack snippets, recipe, taste
context), then the per-call brief or bundle. On `anthropic/*` models the
OpenRouter client marks cache breakpoints on the system prompt and the cached
parts, and cache-read tokens are recorded on each model call, so the cache hit
ratio is visible in traces. Retrieved Taste Memory preferences are **planned**
([SEARCH.md](SEARCH.md#taste-memory)).
