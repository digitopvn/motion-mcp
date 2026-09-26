# 0012. Domain pack: lift and wrap ak-motion-video

## Status

Accepted.

## Context

The ak-motion-video skill (MIT, BestAgentKits) is vendored from
`bestagentkits/motion-video-skill`. It already contains most of a motion
domain pack:

- style profiles that follow a strict schema of closed dimensions and scene
  types;
- a deterministic style resolver;
- an audio and beat-sync pipeline;
- documented pitfalls.

Sibling skills add material under two licenses:

- **ak-motion-design** (MIT) adds easing, duration and choreography tables.
- **ak-hyperframes** (Apache-2.0) adds the HyperFrames contract.

Many profiles are "brand-inspired" aliases, which carry legal risk in a
commercial product.

## Decision

- **Lift and wrap.** Keep the profile YAML schema, the resolver and the
  pipeline scripts essentially unchanged, behind tools in
  `packages/domain-pack`. The prose references are normalized into thin
  indexes: principles, quality rubric, shot patterns, typography, transitions,
  antipatterns and pacing. Audio and mix numbers belong in tool configuration,
  not in prompts.
- **Tag-based retrieval.** Use the pack's own facets: `style_id`, `dimension`,
  `scene_type`, `role` (director or worker), `format`, `energy`,
  `personality`, `invariant` and `pipeline_step`. Directors get index-level
  summaries. Workers get only the slices resolved for their scene, and
  invariant rules are always injected.
- **Brand-inspired aliases are disabled by default.** Enabling them is an
  explicit workspace setting.
- **Attribution.** Keep the upstream `LICENSE` files and attribution headers,
  and record the upstream source and commit in the pack.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Full re-authoring into a new schema | Forks from a young, fast-moving upstream and discards validation that already works. |
| Prompt-injecting the raw skill documents | The highest token cost, with no gates that can be enforced. |

## Reason

Wrapping keeps the pack diffable against upstream and keeps retrieval cheap, at
a scene-sized slice rather than a whole profile.

## Trade-offs

- The pack's scripts are Python (numpy and scipy for beat fitting), so the
  worker image needs that runtime, or the scripts need porting when the media
  phase lands.
- The pack assumes 16:9 at 1080p. Layout and caption entries must be tagged by
  format before vertical or square formats are supported.
- Most profiles have never been rendered, so their quality is unproven.

## Migration strategy

Upstream updates are pulled as a diff and re-validated with the resolver's
`validate` command. Normalized indexes are regenerated from the profiles, not
edited by hand. A profile can later be renamed or replaced without changing the
retrieval facets.
