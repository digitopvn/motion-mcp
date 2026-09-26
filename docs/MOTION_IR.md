# Motion IR v0.1

Motion IR is the renderer-neutral contract that connects creative direction to
rendering ([ADR 0002](decisions/0002-renderer-neutral-motion-ir.md)). The zod
schemas in `packages/motion-ir` are the source of truth, and the JSON Schema
that `motion_inspect` serves is exported from them. That package is planned. If
this document and the zod schemas ever disagree, the schemas win, and this
document should be corrected.

## Documents

| Document | Produced by | Consumed by |
|---|---|---|
| `TastePacket` | Director Stage 1, or the host model | The IR compiler, Taste Memory |
| `CreativeSpec = { tastePacket, sceneArchitecture }` | Director Stage 1+2, or the host model | `motion_ir.compile` |
| `MotionIR` | The deterministic compiler (the `CreativeSpec` plus domain-pack defaults) | Scene builders, QA, renderers |
| `ScenePatch` | Opus critique, the host critique, `motion_edit`, Jev-routed mechanical fixes | The patch applier (a new IR version) |

## Renderer-neutral rules

1. The IR contains no HTML, CSS selectors, class names, GSAP or HyperFrames
   identifiers, and no code.
2. Easing, size, weight and color are **tokens**. Each compiler maps tokens to
   its renderer, and the HyperFrames compiler is the first such target.
3. Times are in seconds and are relative to the start of the scene. Scene
   start times are derived from their order and durations and are never
   stored.
4. Element ids are unique within a scene. Scene ids are unique within the
   video.
5. The IR is serialized as JSON only, with no functions, `undefined` or `NaN`.

## Token vocabularies

| Vocabulary | Tokens |
|---|---|
| Easing | `standard`, `emphasized`, `decelerate`, `accelerate`, `linear`, `spring-soft` |
| Size | `display-xl`, `display`, `headline`, `title`, `body`, `caption`, `label` |
| Color | the keys of `brand.colors`: `background`, `foreground`, `accent`, `muted`, plus any extra named brand keys |
| Font | `display`, `body`, `mono` (the keys of `brand.fonts`) |

`linear` is permitted only for non-spatial properties such as opacity and
counters. The domain-pack rubric treats linear easing on spatial motion as a
critical defect.

## `MotionIR`

| Field | Type | Notes |
|---|---|---|
| `version` | `"0.1"` | Required. Migrations key on it. |
| `id` | string | A stable IR id. |
| `format` | `{ width, height, fps, duration, aspectRatio }` | Integers for width, height and fps. `duration` is in seconds and must equal the sum of the scene durations. `aspectRatio` is one of `"16:9"`, `"9:16"` or `"1:1"`. |
| `creative` | `{ concept, mood[], tone[], energy, visualDensity, emotionalArc }` | `energy` and `visualDensity` are integers from 1 to 5. `emotionalArc` is one sentence of prose. |
| `brand` | `{ colors, fonts, radius, visualRules[] }` | `colors` maps a token to a hex value and must include `background`, `foreground`, `accent` and `muted`. `fonts` has `{ display, body, mono }` family names. `radius` is in px. `visualRules` are prose constraints. |
| `motionLanguage` | `{ tempo, preferredEasing[], avoidEasing[], cameraMotion, maxSimultaneousObjects, holdRatio, principles[], avoid[] }` | `tempo` is one of `slow`, `measured`, `brisk` or `fast`. The easing lists use easing tokens. `cameraMotion` is one of `none`, `subtle-drift`, `push-in` or `parallax`. `holdRatio` is a number from 0 to 1: the share of each scene in which the focal element is at rest. |
| `audio?` | `{ music?, voiceover?, sfx, loudnessLufs }` | Optional, and used from the media phase onward. `music` is `{ mood, bpmRange: [min, max] }`, `voiceover` is `{ voice, lines: [{ sceneId, text }] }`, `sfx` is a boolean, and `loudnessLufs` defaults to −14. |
| `styleRefs?` | `[{ styleId, dimensions?[] }]` | Domain-pack style ids and, optionally, the dimensions to take from each. |
| `scenes` | `MotionScene[]` | At least one scene. Ordered by `index`. |

## `MotionScene`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within the video, for example `s01-hook`. |
| `index` | integer | Contiguous, starting at 0. |
| `role` | enum | `hook`, `problem`, `mechanism`, `evidence`, `payoff`, `cta`, `title`, `transition` or `custom`. |
| `intent` | string | What the viewer should feel or understand. |
| `purpose` | string | Why the scene exists in the arc. |
| `duration` | number | Seconds, greater than 0. |
| `focalPoint` | string | The element id that carries the scene. |
| `layout` | `{ template, align, safeArea }` | `template` is one of `center`, `split`, `stack`, `grid`, `full-bleed` or `lower-third`. `align` is one of `start`, `center` or `end`. `safeArea` is a fractional inset from 0 to 0.2. |
| `elements` | `SceneElement[]` | At least one. |
| `choreography` | `Beat[]` | May be empty in a `CreativeSpec`. The compiler then fills it from domain-pack shot patterns. |
| `transitionIn` / `transitionOut` | `{ kind, duration }` | `kind` is one of `cut`, `fade`, `slide`, `wipe`, `iris`, `scale-through` or `match-move`. A scene's `transitionOut` must equal the next scene's `transitionIn`, and two consecutive scene boundaries must not use the same kind. |
| `assetNeeds` | `[{ id, kind, description }]` | `kind` is one of `image`, `icon`, `logo`, `video` or `audio`. These are resolved by search first, then by generation. |
| `constraints` | string[] | Hard rules for this scene. |
| `antiPatterns` | string[] | Things the builder must not do. |
| `acceptance` | string[] | Checkable criteria that critique evaluates. |
| `needsCustomCode?` | boolean | Set by the compiler or by routing. When true, a Pi worker builds the scene instead of the deterministic compiler. |

## `SceneElement`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within the scene. |
| `kind` | enum | `text`, `metric`, `code`, `shape`, `image`, `list` or `logo`. |
| `role` | enum | `hero`, `secondary`, `tertiary` or `annotation`. There is at most one `hero` per scene. |
| `content` | string, or string[] for `list` | Text, code, a metric value, or an asset reference (`asset:<assetNeedId>`). |
| `style` | `{ size, weight, color, font? }` | `size` is a size token. `weight` is one of `regular`, `medium`, `semibold`, `bold` or `black`. `color` is a color token. `font` is a font token. |
| `position?` | enum | A hint: `center`, `top`, `bottom`, `left`, `right`, `top-left`, `top-right`, `bottom-left` or `bottom-right`. |

## `Beat`

| Field | Type | Notes |
|---|---|---|
| `target` | string | An element id in the same scene. |
| `primitive` | enum | `fade-in`, `fade-up`, `mask-reveal`, `type-on`, `scale-in`, `slide`, `draw`, `count-up`, `stagger`, `hold` or `exit`. |
| `at` | number or string | Seconds from the scene start, or `after:<elementId>+<seconds>`, for example `after:title+0.2`. The reference resolves to the end of the latest earlier beat on that element, and cycles are invalid. |
| `duration` | number | Seconds. The beat must end at or before the scene duration. |
| `easing` | easing token | Defaults to `motionLanguage.preferredEasing[0]`. |

## `TastePacket` and `CreativeSpec`

`TastePacket` is the part of the IR that holds taste. It has the shape
`{ creative, brand, motionLanguage, audio?, styleRefs? }`, and each field has
the same shape as the matching `MotionIR` field.

`sceneArchitecture` has the shape `{ format, scenes }`. Its scenes follow
`MotionScene`, with `choreography` and `needsCustomCode` optional.

`CreativeSpec` has the shape `{ tastePacket, sceneArchitecture }`. It is the
only document a host model writes in `host-opus` mode. Compilation adds
`version` and `id`, fills defaults from the domain pack, resolves `after:`
references, and validates the result.

## `ScenePatch`

```ts
ScenePatch {
  sceneId: string
  changes: Array<{
    type: "timing" | "motion" | "layout" | "typography" | "color" | "content" | "asset" | "transition"
    instruction: string          // what to change, in plain language
    target?: string              // element id; omit for scene-level changes
    params?: Record<string, unknown>  // typed hints, e.g. { duration: 1.2 } or { easing: "decelerate" }
  }>
}
```

The patch applier first applies whatever `params` can express
deterministically, and routes the remaining changes to a Pi worker. Applying a
patch always creates a new IR version, and earlier versions are never mutated.

## Versioning and migration

- `version` uses the form `major.minor`. A minor release may only add optional
  fields. Anything that removes, renames or retypes a field is a major release.
- Migrations are pure functions in `packages/motion-ir` that chain one version
  to the next. Stored `motion_ir_versions` keep their original `ir_version` and
  are migrated when read.
- The exported JSON Schema is versioned alongside the IR, and
  `motion_inspect({ target: "capabilities" })` reports the version the server
  accepts.

## Example: a 30-second developer-tool launch

The example has 6 scenes: 4 + 5 + 6 + 5 + 5 + 5 = 30 seconds.

```json
{
  "version": "0.1", "id": "ir_tracekit_launch",
  "format": { "width": 1920, "height": 1080, "fps": 30, "duration": 30, "aspectRatio": "16:9" },
  "creative": { "concept": "Flaky tests become one clear root cause", "mood": ["precise", "calm"],
    "tone": ["confident", "technical"], "energy": 3, "visualDensity": 2,
    "emotionalArc": "Frustration at noise resolves into relief at a single answer." },
  "brand": { "colors": { "background": "#0B0D10", "foreground": "#E8EAED", "accent": "#5EEAD4", "muted": "#6B7280" },
    "fonts": { "display": "Inter", "body": "Inter", "mono": "JetBrains Mono" }, "radius": 12,
    "visualRules": ["One accent use per scene", "Code is always monospace"] },
  "motionLanguage": { "tempo": "measured", "preferredEasing": ["decelerate", "standard"], "avoidEasing": ["linear"],
    "cameraMotion": "subtle-drift", "maxSimultaneousObjects": 4, "holdRatio": 0.35,
    "principles": ["Lead with the hero", "One idea per scene"], "avoid": ["Corner HUD chrome", "Opacity-only state changes"] },
  "styleRefs": [{ "styleId": "precision-dark-product" }],
  "scenes": [
    { "id": "s01-hook", "index": 0, "role": "hook", "intent": "Recognition of the pain", "purpose": "Stop the scroll",
      "duration": 4, "focalPoint": "q", "layout": { "template": "center", "align": "center", "safeArea": 0.08 },
      "elements": [{ "id": "q", "kind": "text", "role": "hero", "content": "Green locally. Red in CI. Again.",
        "style": { "size": "display", "weight": "bold", "color": "foreground", "font": "display" } }],
      "choreography": [{ "target": "q", "primitive": "type-on", "at": 0.2, "duration": 1.6, "easing": "standard" },
        { "target": "q", "primitive": "hold", "at": "after:q+0", "duration": 1.8, "easing": "standard" }],
      "transitionIn": { "kind": "cut", "duration": 0 }, "transitionOut": { "kind": "fade", "duration": 0.3 },
      "assetNeeds": [], "constraints": [], "antiPatterns": ["Emoji"], "acceptance": ["Headline readable by 2.0s"] },
    { "id": "s02-problem", "index": 1, "role": "problem", "intent": "Show the noise", "purpose": "Make the cost concrete",
      "duration": 5, "focalPoint": "log", "layout": { "template": "full-bleed", "align": "start", "safeArea": 0.06 },
      "elements": [{ "id": "log", "kind": "code", "role": "hero", "content": "FAIL test/api.spec.ts > retries (timeout 5000ms)\n...",
          "style": { "size": "body", "weight": "regular", "color": "muted", "font": "mono" } },
        { "id": "count", "kind": "metric", "role": "secondary", "content": "412 failing runs",
          "style": { "size": "headline", "weight": "semibold", "color": "accent" }, "position": "bottom-right" }],
      "choreography": [{ "target": "log", "primitive": "stagger", "at": 0, "duration": 2.5, "easing": "standard" },
        { "target": "count", "primitive": "count-up", "at": 2.2, "duration": 1.4, "easing": "decelerate" }],
      "transitionIn": { "kind": "fade", "duration": 0.3 }, "transitionOut": { "kind": "wipe", "duration": 0.4 },
      "assetNeeds": [], "constraints": ["Log text is illustrative, not a real customer"], "antiPatterns": [], "acceptance": ["Metric lands before 4.0s"] },
    { "id": "s03-mechanism", "index": 2, "role": "mechanism", "intent": "Understand how it works", "purpose": "Explain in one diagram",
      "duration": 6, "focalPoint": "flow", "layout": { "template": "stack", "align": "center", "safeArea": 0.08 },
      "elements": [{ "id": "cmd", "kind": "code", "role": "secondary", "content": "$ tracekit analyze ./ci-logs",
          "style": { "size": "title", "weight": "medium", "color": "foreground", "font": "mono" }, "position": "top" },
        { "id": "flow", "kind": "shape", "role": "hero", "content": "logs → cluster → diff → root cause",
          "style": { "size": "title", "weight": "semibold", "color": "accent" } }],
      "choreography": [{ "target": "cmd", "primitive": "type-on", "at": 0.2, "duration": 1.2, "easing": "standard" },
        { "target": "flow", "primitive": "draw", "at": "after:cmd+0.3", "duration": 2.5, "easing": "emphasized" }],
      "transitionIn": { "kind": "wipe", "duration": 0.4 }, "transitionOut": { "kind": "match-move", "duration": 0.5 },
      "assetNeeds": [], "constraints": [], "antiPatterns": ["More than 4 nodes"], "acceptance": ["Diagram fully drawn by 4.5s"] },
    { "id": "s04-evidence", "index": 3, "role": "evidence", "intent": "Trust the result", "purpose": "Show the report",
      "duration": 5, "focalPoint": "report", "layout": { "template": "split", "align": "center", "safeArea": 0.08 },
      "elements": [{ "id": "report", "kind": "image", "role": "hero", "content": "asset:report-shot",
          "style": { "size": "body", "weight": "regular", "color": "foreground" }, "position": "left" },
        { "id": "cause", "kind": "text", "role": "secondary", "content": "Root cause: shared port in parallel workers",
          "style": { "size": "title", "weight": "semibold", "color": "accent" }, "position": "right" }],
      "choreography": [{ "target": "report", "primitive": "scale-in", "at": 0, "duration": 0.8, "easing": "decelerate" },
        { "target": "cause", "primitive": "fade-up", "at": "after:report+0.2", "duration": 0.6, "easing": "decelerate" }],
      "transitionIn": { "kind": "match-move", "duration": 0.5 }, "transitionOut": { "kind": "fade", "duration": 0.3 },
      "assetNeeds": [{ "id": "report-shot", "kind": "image", "description": "Tracekit HTML report, dark theme, 16:10" }],
      "constraints": [], "antiPatterns": [], "acceptance": ["Cause text contrast passes WCAG AA"] },
    { "id": "s05-payoff", "index": 4, "role": "payoff", "intent": "Relief", "purpose": "State the outcome",
      "duration": 5, "focalPoint": "stat", "layout": { "template": "center", "align": "center", "safeArea": 0.08 },
      "elements": [{ "id": "stat", "kind": "metric", "role": "hero", "content": "3 minutes",
          "style": { "size": "display-xl", "weight": "black", "color": "foreground" } },
        { "id": "label", "kind": "text", "role": "annotation", "content": "from red build to root cause",
          "style": { "size": "caption", "weight": "medium", "color": "muted" }, "position": "bottom" }],
      "choreography": [{ "target": "stat", "primitive": "scale-in", "at": 0.1, "duration": 0.7, "easing": "spring-soft" },
        { "target": "label", "primitive": "fade-in", "at": "after:stat+0.2", "duration": 0.5, "easing": "decelerate" }],
      "transitionIn": { "kind": "fade", "duration": 0.3 }, "transitionOut": { "kind": "iris", "duration": 0.5 },
      "assetNeeds": [], "constraints": [], "antiPatterns": ["Overshoot above 25%"], "acceptance": ["Stat holds still for at least 2s"] },
    { "id": "s06-cta", "index": 5, "role": "cta", "intent": "Act now", "purpose": "Install command",
      "duration": 5, "focalPoint": "install", "layout": { "template": "center", "align": "center", "safeArea": 0.1 },
      "elements": [{ "id": "logo", "kind": "logo", "role": "secondary", "content": "asset:logo",
          "style": { "size": "title", "weight": "regular", "color": "foreground" }, "position": "top" },
        { "id": "install", "kind": "code", "role": "hero", "content": "npm i -g tracekit",
          "style": { "size": "headline", "weight": "semibold", "color": "accent", "font": "mono" } }],
      "choreography": [{ "target": "logo", "primitive": "fade-in", "at": 0, "duration": 0.6, "easing": "decelerate" },
        { "target": "install", "primitive": "mask-reveal", "at": 0.6, "duration": 0.8, "easing": "emphasized" },
        { "target": "install", "primitive": "hold", "at": "after:install+0", "duration": 3.0, "easing": "standard" }],
      "transitionIn": { "kind": "iris", "duration": 0.5 }, "transitionOut": { "kind": "cut", "duration": 0 },
      "assetNeeds": [{ "id": "logo", "kind": "logo", "description": "Tracekit wordmark, supplied by user" }],
      "constraints": ["End on a still frame"], "antiPatterns": [], "acceptance": ["Install command on screen for at least 3s"] }
  ]
}
```
