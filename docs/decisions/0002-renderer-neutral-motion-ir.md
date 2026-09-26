# 0002. Renderer-neutral Motion IR with zod as source of truth

## Status

Accepted.

## Context

Nothing upstream offers a renderer-neutral description of a motion video.
HyperFrames compositions are HTML with GSAP timelines, which is a compile
target, not a creative contract. Motion MCP needs one contract that serves
several consumers:

- host models, which write specs through JSON Schema;
- the internal director, which uses structured outputs;
- the deterministic compiler;
- Pi workers;
- QA, critique and patches.

## Decision

- Motion IR (v0.1) is the contract between direction and rendering. The IR also
  covers `TastePacket`, `CreativeSpec` and `ScenePatch`. The design is in
  [MOTION_IR.md](../MOTION_IR.md).
- The IR contains no HTML, CSS, GSAP or HyperFrames identifiers. Easing, size,
  weight and color are tokens that each compiler maps.
- The zod schemas in `packages/motion-ir` are the source of truth. JSON Schema
  is exported from them with `z.toJSONSchema()`, and that export is served to
  hosts and used for OpenRouter `json_schema` structured outputs.
- HyperFrames is the first compiler target.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Target HyperFrames HTML directly | It couples taste to one renderer. Critique and patches would have to reason over HTML. |
| Target `@hyperframes/core` `TimelineElement` | Still renderer-specific. Core documents its parse and generate as lossy for inline formatting. |
| JSON Schema as the source, with generated types | Weaker runtime validation ergonomics. The MCP SDK already uses zod v4. |
| TypeBox as the source (what Pi uses) | Pi's use of TypeBox is limited to tool parameters. The rest of the stack, including the MCP SDK, uses zod. |

## Reason

A neutral IR keeps the taste layer portable and makes critique and patches
operate at the level of scenes and elements. A single zod source removes drift
between runtime validation, TypeScript types and the schema that host models
see.

## Trade-offs

- The deterministic compiler's quality is bounded by its primitive vocabulary.
  Scenes that need more are sent to Pi, at a higher cost.
- The tokens need a mapping table for each renderer.

## Migration strategy

`version` is required. Minor versions only add optional fields. Breaking
changes bump the major version and ship a pure migration function, and stored
IR is migrated when read. A second renderer is added as a new compiler package
that consumes the same IR.
