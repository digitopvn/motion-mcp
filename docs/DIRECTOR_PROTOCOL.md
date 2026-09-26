# Director Protocol

The director supplies taste. It turns a brief into a `CreativeSpec` and judges
creative issues. It never writes renderer code. The implementation is planned
in `packages/director`, and the schemas it produces are defined in
[MOTION_IR.md](MOTION_IR.md).

## DirectorMode

```ts
type DirectorMode = "host-opus" | "internal-opus" | "custom";
```

| Mode | Where Stage 1+2 runs | Where Stage 3 critique runs |
|---|---|---|
| `host-opus` | In the calling host model. The host passes `creativeSpec` to `motion_create`. | In the host. The pipeline returns a critique request. |
| `internal-opus` | Opus through OpenRouter (`PLANNER_MODEL`, default `anthropic/claude-opus-5.5`). | Opus through OpenRouter. |
| `custom` | A planner model the workspace configures, which must support structured outputs. | The same model. |

The mode resolves in this order: the per-call `directorMode`, then the
workspace default, then `internal-opus`. The server never infers the mode from
the MCP client name, the model name or the user agent
([ADR 0003](decisions/0003-explicit-director-mode.md)). The resolved mode is
returned by every `motion_create` and `motion_edit` call and recorded on the
trace.

## Handshake

A host that wants to direct calls `motion_inspect({ target: "capabilities" })`
before `motion_create`. The response contains:

- `irVersion`, and the accepted `directorModes`;
- `creativeSpecSchema`, the JSON Schema exported from the zod `CreativeSpec`;
- `promptGuidance`, the same creative rules the internal director follows:
  scene roles, token vocabularies, pacing and antipatterns;
- `pricing`, the credit prices for each operation, and the account's `limits`.

A host spec that fails validation returns `isError` with the zod issues. No
model is called, so the host can correct the spec at no cost.

## Stages

| Stage | Purpose | Input contract | Output contract | Default budget (in / out tokens) |
|---|---|---|---|---|
| 1+2 Direction and architecture (one call) | Taste and scene structure | The brief, the `format`, the domain-pack director slice (style index summary, principles, pacing), recipe defaults, Taste Memory preferences, and the `CreativeSpec` schema | `CreativeSpec = { tastePacket, sceneArchitecture }` | 12k / 6k |
| 3 Critique | Judge the creative issues Jev routed here | A scene-isolated critique bundle (below), one per flagged scene, batched | `{ verdict: "accept" \| "revise", scenePatches: ScenePatch[], notes }` | 8k / 2k per scene |
| 4 Polish | An optional final pass on an accepted cut | A contact sheet of the whole video, the `TastePacket`, and the IR summary (scene roles, durations, transitions) | `ScenePatch[]` limited to `timing`, `typography`, `color` and `transition` changes | 10k / 2k |

- Stages 1 and 2 are defined separately but run as one structured-output call,
  so the brief and domain context are paid for once.
- Stages 3 and 4 run only when Jev decides `needs_opus` (see
  [JEV_ROUTING.md](JEV_ROUTING.md)).
- The budgets are configuration defaults. A call that would exceed its budget
  is trimmed by dropping lower-priority context, such as extra style slices,
  never the schema or the brief.
- Every output is validated with zod. When validation fails, the director
  makes one repair call that includes the validation issues. If that also
  fails, the job fails with a typed error.

## Scene-isolation critique bundle

A critique request covers one scene and never the whole project. The bundle
contains:

- the scene's IR, together with its `acceptance`, `constraints` and
  `antiPatterns`;
- the `TastePacket` summary (creative, brand and motion language);
- frames from that scene only, taken from the snapshot sweep at its start,
  middle, end and focal beat;
- the normalized QA issues for the scene, with their Jev classification;
- the transition kinds at its neighbouring boundaries. The neighbouring scenes'
  content is not included.

Isolation keeps both the tokens and the blast radius small. A patch can only
name the scene it was asked about.

## Host-mode critique requests

In `host-opus` mode, the pipeline never calls Opus. When Jev classifies an
issue as creative, the pipeline does three things:

1. It moves the job to `awaiting_host`.
2. It returns a `critiqueRequest` from `motion_get_project` that contains
   `{ requestId, bundles[], responseSchema }`, where `responseSchema` is the
   JSON Schema for the Stage 3 output.
3. It waits for the host to call `motion_edit({ projectId, critiqueRequestId,
   scenePatches })`.

If the host does not answer, the job stays in `awaiting_host`. It spends no
credits while waiting, and the host can still render the current version with
`motion_render`.

## Prompt caching

Prompts are assembled so that the most stable parts come first:

1. the system prompt;
2. the schema;
3. the domain-pack slices;
4. Taste Memory preferences;
5. the per-call content: the brief, or the bundle.

The director marks cache breakpoints after the stable prefix, following
OpenRouter's pass-through for Anthropic prompt caching. Cache-read tokens are
recorded on each `model_call`, so the cache hit ratio can be observed. This
behavior has not yet been verified against live OpenRouter billing, so it needs
confirming during the director phase.
