# Motion IR v0.1

Motion IR is the renderer-neutral contract that connects creative direction to
rendering ([ADR 0002](decisions/0002-renderer-neutral-motion-ir.md)). The zod
schemas in `packages/motion-ir/src` are the source of truth, and the JSON
Schemas that `motion_inspect` serves (and `pnpm motion schema` prints) are
exported from them. This document explains the shape and the rules behind it;
it deliberately does not restate field lists, which would drift.

## Documents

| Document | Schema | Produced by | Consumed by |
|---|---|---|---|
| `TastePacket` | `creative-spec.ts` | Director Stage 1, or the host model | The spec compiler, critique bundles, Taste Memory (planned) |
| `CreativeSpec` | `creative-spec.ts` | Director Stage 1+2 as one call, or the host model in `host-opus` mode | `compileCreativeSpec` in `compile-spec.ts` |
| `MotionIR` | `motion-ir.ts` | `compileCreativeSpec`: the spec plus defaults, with version, id and derived timing | Scene builders, QA, renderers |
| `ScenePatch` | `patch-and-qa.ts` | Director critique, host critique, `motion_edit`, mechanical fixes | `applyScenePatch` in `apply-patch.ts`, which produces a new IR |
| `QaIssue` | `patch-and-qa.ts` | Lint, check, vision QA, the timeline, renders | Jev classification and critique bundles |

Worked examples live in [`fixtures/golden/`](../fixtures/golden/): five
`creative-spec.json` files that the adapter tests compile and lint.

## Why the split

- **`TastePacket` is taste only.** It holds creative intent, mood, energy,
  visual hierarchy, motion language, typography, color and audio direction. It
  is stored once and reused across scenes and revisions, so the full brief and
  conversation never have to be resent.
- **`CreativeSpec` is the only document a host writes.** It is the
  `TastePacket` plus the scene architecture: scenes with roles, intent,
  duration, focal point, layout, elements, and optional choreography,
  transitions, asset needs, anti-patterns and acceptance criteria. Choreography
  is optional because the compiler can derive it, which keeps host specs small.
- **`MotionIR` is what builders and renderers read.** Compilation fills
  defaults, fixes format and timing, and validates cross-references, so every
  consumer sees one fully resolved document.
- **`ScenePatch` is how everything changes.** Critique, host answers, user
  edits and mechanical fixes all speak the same patch language, and each patch
  names one scene.

## Renderer-neutral rules

1. The IR contains no HTML, CSS selectors, class names, GSAP or HyperFrames
   identifiers, and no code.
2. Easing, size, weight, color, font and tempo are **tokens** (`tokens.ts`).
   Each compiler maps tokens to its renderer; the HyperFrames compiler is the
   first target.
3. Times are in seconds, relative to the start of the scene. A beat starts at a
   number of seconds, or `after` or `with` another element's beat plus an
   offset. Scene start times are derived from order and durations, never stored.
4. Ids are lowercase kebab-case. Scene ids are unique within the video, and
   element ids are unique within a scene. Beats may only reference elements of
   their own scene. The schema enforces all of this.
5. The IR is serialized as JSON only, with no functions, `undefined` or `NaN`.
6. `linear` easing belongs only on non-spatial properties such as opacity and
   counters. The domain-pack rubric treats linear easing on spatial motion as a
   critical defect.
7. Scenes marked `implementation: "custom"` may be built by a Pi worker instead
   of the deterministic compiler (see [AGENT_RUNTIME.md](AGENT_RUNTIME.md)).

## Patches

A `ScenePatch` change always carries a plain-language `instruction`. Optional
`params` make the change deterministically applicable. `applyScenePatch`
applies what `params` can express and returns the rest as deferred changes,
which the pipeline hands to a Pi worker as instructions. Applying a patch always
yields a new IR version; stored versions are never mutated.

## Versioning

- `version` uses the form `major.minor`. A minor release may only add optional
  fields. Anything that removes, renames or retypes a field is a major release.
- `motion_inspect({ target: "capabilities" })` reports the accepted
  `irVersion`, and the exported JSON Schemas are versioned with the IR.
- **Planned:** migrations as pure functions in `packages/motion-ir` that chain
  one version to the next, applied when stored versions are read. None exist
  yet, because only 0.1 has shipped.
