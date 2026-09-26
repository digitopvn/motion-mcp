# Product

Motion MCP is an open-source (MIT) motion-video production runtime exposed as a
Streamable HTTP MCP server. The design is recorded here; the code has not been
written yet. The [roadmap](ROADMAP.md) tracks which parts are built.

## Objective

A host model calls `motion_create` with a brief and gets back a rendered,
web-optimized MP4. The host can be Claude, ChatGPT, Pi or any other MCP client.
Motion MCP spends money only on work that needs judgment:

- Opus handles creative direction and critique.
- A bounded decision model, Jev, routes work (see [JEV_ROUTING.md](JEV_ROUTING.md)).
- A deterministic compiler, or Pi driving a cheap model, turns the scenes into
  HyperFrames compositions.
- FFmpeg finishes the output.

HeyGen already hosts a cloud-only HyperFrames MCP, so "MCP for HyperFrames"
does not set this project apart. Motion MCP differs in three ways:

1. **Taste layer.** A director, a renderer-neutral [Motion IR](MOTION_IR.md) and
   Taste Memory.
2. **Cost-aware routing.** Every escalation is a typed, traced decision.
3. **Self-hosted rendering.** Renders run in a pinned Linux container.

## Users

| User | What they need |
|---|---|
| Host-model user (Claude, ChatGPT, Pi, other MCP clients) | Turn a brief into a finished video without leaving the chat or agent session. |
| Developer or marketer shipping a launch, feature or explainer video | Brand-consistent motion graphics at a predictable cost. |
| Self-hoster | Run the whole stack on their own machine or VPS with their own provider keys. |
| Operator of the hosted service at `app.motion.digitop.ai` | Margin, reliability and cost visibility per job. |

## Director modes

The client chooses the director mode on each call, or the workspace default
applies. The server never infers the mode from model names
([ADR 0003](decisions/0003-explicit-director-mode.md)). The full contract is in
[DIRECTOR_PROTOCOL.md](DIRECTOR_PROTOCOL.md).

| Mode | Who writes the creative spec | When to use it |
|---|---|---|
| `host-opus` | The calling host model writes the spec, using the JSON Schema that `motion_inspect` returns. | The host is already a frontier model, so paying for a second Opus call would duplicate taste the client has already paid for. |
| `internal-opus` | Motion MCP calls Opus through OpenRouter. | The host is a small model or a script, or the user wants the platform's direction. |

The design also reserves a third value, `custom`. It runs the same contracts
with a planner model the workspace configures.

**Example, `internal-opus`:**

```json
{ "name": "motion_create", "arguments": {
  "brief": "30s launch video for Tracekit, a CLI that turns flaky test logs into a root-cause report. Dark, precise, developer audience.",
  "directorMode": "internal-opus", "quality": "final", "budgetCredits": 400 } }
```

**Example, `host-opus`.** The host calls `motion_inspect({ "target": "capabilities" })`,
writes a `CreativeSpec` that validates against the returned schema, and then
sends it:

```json
{ "name": "motion_create", "arguments": {
  "brief": "30s launch video for Tracekit ...",
  "directorMode": "host-opus",
  "creativeSpec": { "tastePacket": { "...": "..." }, "sceneArchitecture": { "...": "..." } } } }
```

If the spec is valid, the internal director is skipped. If it is invalid, the
call returns validation issues so the host can fix the spec, and no Opus spend
occurs.

## Non-goals for v1

- A polished dashboard, the marketing site, billing, hybrid search and Taste
  Memory learning must not block the vertical slice. They are designed now and
  land in later phases.
- Team and workspace management, 4K cloud rendering and generative video are
  outside the first slice.
- The public tool surface stays at eight tools ([MCP_API.md](MCP_API.md)). New
  capability goes into those tools' arguments, not into new public tools.
- CI never calls paid frontier models. Live model tests run only when someone
  opts in.
- Motion MCP does not re-implement HyperFrames, Pi or multix
  ([ADR 0005](decisions/0005-hyperframes-hybrid-integration.md),
  [ADR 0006](decisions/0006-pi-embedded-runtime.md),
  [ADR 0007](decisions/0007-multix-cli-runner.md)).

## Success metric

```
value = quality × reliability × gross margin ÷ latency
```

| Factor | How it is measured |
|---|---|
| Quality | The share of rubric gates passed (lint and check clean, pacing, contrast, loudness) plus the director's critique verdict on the final cut. |
| Reliability | The share of jobs that reach a lint-clean final MP4 without human intervention and within budget. |
| Gross margin | `(revenue − COGS) ÷ revenue` per job. Revenue comes from the [credit ledger](BILLING.md) and COGS comes from the [trace cost fields](OBSERVABILITY.md). |
| Latency | Wall-clock time from brief to final MP4, tracked at p50 and p95. |

These factors multiply, so a gain in one cannot hide a collapse in another. A
beautiful video that costs more than it earns scores low, and so does a cheap
video that fails half the time.

## The "does this need taste?" principle

Ask this before every model call. If the step is mechanical, code does it:
normalizing input, compiling IR, linting, fixing a timing overflow, muxing
audio. If the step needs judgment, the cheapest model that can make that
judgment does it. Opus is reserved for creative direction and creative critique.
When the answer is unclear, a typed Jev decision settles it and gets traced;
nobody escalates by default.

## Cost rules

1. **Deterministic first.** Intent normalization, IR compilation, linting,
   checks and FFmpeg finishing are code, not model calls.
2. **Opus only for taste.** Opus writes the creative spec and critiques creative
   issues. It never writes HyperFrames HTML.
3. **One call for direction.** The internal director produces creative
   direction and scene architecture in a single structured call, so the shared
   context is paid for once.
4. **Respect a host spec.** A valid `host-opus` spec skips the internal director
   entirely.
5. **Jev gates escalation.** Critique and polish run only when a Jev decision
   says Opus is needed.
6. **Cheap coder by default.** Pi runs on the configured `CODER_MODEL`, which
   defaults to `deepseek/deepseek-v4-flash`.
7. **The compiler before Pi.** The deterministic compiler builds each scene
   unless that scene needs bespoke code.
8. **Scene isolation.** Critique, patches and rebuilds touch only the affected
   scenes, never the whole video.
9. **Snapshot before render.** Quality checks run on the contact sheet and on
   `check` output. A render happens only when Jev judges it justified.
10. **Draft previews.** Previews render at draft quality. The final render runs
    once, after the spec is accepted.
11. **Bounded loops.** Revision loops have a fixed maximum, and the remaining
    budget is checked before every paid step.
12. **Cache stable prefixes.** Prompts are ordered so that the system prompt,
    schema and domain-pack slices form a cacheable prefix.
13. **Retrieve slices, not packs.** Workers get the style dimensions resolved
    for their scene, not whole style profiles.
14. **Reuse before generating.** Search existing assets and registry blocks
    before paying a media provider, and skip provider-side extras such as
    `snapshot --describe`.
15. **Account for every cost.** Every paid step records its cost on a trace
    span. A job whose estimated cost exceeds its remaining budget stops and
    reports the shortfall instead of overspending.
