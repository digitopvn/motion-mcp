# Roadmap

The phases are listed in dependency order. Execution plans and implementation
reports live in `plans/`; this file changes only when a phase's scope, status or
acceptance criteria change. "Implemented" means the code exists in the
repository; the tests and CI are the proof that it works.

| Phase | Scope | Acceptance criteria | Status |
|---|---|---|---|
| 0 Research | HyperFrames, Pi, Jev, MCP SDK, multix, and the ak-motion-video domain pack | Research reports exist, and the architecture synthesis records the decisions. | Done |
| 1 Core schemas | The pnpm monorepo, `shared`, `motion-ir`, `observability`, `storage`, and the `database` interfaces with the file-backed store | Zod schemas exist for Motion IR, `TastePacket`, `CreativeSpec` and `ScenePatch`, and the JSON Schema export works. Golden fixtures validate. The redaction and ledger-math unit tests pass. | Implemented |
| 2 HyperFrames adapter | The deterministic IR→HTML compiler, in-process lint, and CLI `check` and `snapshot` calls using `--json`. Renders through the producer. FFmpeg finishing. | The golden IR compiles to a project that passes lint. A draft preview and a 1080p final render are produced locally. Contract tests pin the HyperFrames version. | Implemented |
| 3 Pi runtime | Session wrapper, tool allow-list, `submit_scene`, path guard, prompt building, event→span mapping | A Pi scene build on a fixture passes lint, or the scene falls back to the compiler. The path guard blocks writes outside the job directory. Tests use a faux model, and a live test runs only on opt-in. | Implemented. Engine-backed custom tools are planned. |
| 4 Director | The `internal-opus` Stage 1+2 call, host spec validation, the critique bundle, and host critique requests | A brief produces a zod-valid `CreativeSpec`. An invalid host spec returns issues and makes no model call. | Implemented. The polish stage and `custom` mode are planned. |
| 5 Jev | `DecisionClient` with the TypeSafe, LLM and rules adapters, plus routing policies and caps | Every question returns a typed answer when no keys are present, through the rules adapter. The model id is configurable. Each decision is traced. | Implemented. The TypeSafe adapter is untested against the live API. |
| 6 MCP server | The eight public tools, bearer auth, the host allow-list, job polling, public routes and the `motion` CLI | An in-process MCP client test covers every tool, including auth failures and schema rejections. | Implemented |
| V1 vertical slice | End-to-end run from brief to MP4, plus deployment (see below) | All of the slice criteria below pass locally. The deploy is attempted. | Implemented locally. Deployment files and workflows exist; see [ARCHITECTURE.md](ARCHITECTURE.md#deployment-topology). |
| 7 Media | The multix runner, capability matrix, price table, FFmpeg transforms, and audio mix | Assets are generated with a scrubbed environment. Asset costs appear on the trace. Loudness is at −14 LUFS when audio is present. | Partial. The runner, matrix, registry, price table and FFmpeg finishing exist; scene images are generated in create and edit jobs (workspace keys first, then server keys); video, speech, music and sound-effect generation are not wired into the pipeline, and audio mixing is not built. |
| 8 Dashboard | `apps/dashboard` with an embedded HyperFrames Studio preview, and project and render views | A user can view projects, play renders and edit in Studio, with the edits saved as a new version. | Partly implemented: GitHub sign-in, videos (list, create, player, versions, QA, IR, traces), search, recipes, API keys, usage and billing at `app.motion.digitop.ai`. Editing in an embedded Studio, team members and Google sign-in are planned. |
| 9 Search and Taste Memory | `packages/search`, `packages/taste-memory`, `search_documents` indexing | The exact-match short-circuit, RRF fusion and the ambiguous-only rerank are covered by tests. Retrieved preferences appear in director traces. | Planned. An interim in-process BM25 search serves `motion_search` ([SEARCH.md](SEARCH.md)). |
| 10 Polar billing | The ledger in production, Polar checkout and webhooks, BYOK credentials, and limits | The ledger stays balanced under replayed webhooks. Margin is reported per job. `insufficient_credits` and `budget_exceeded` behave as specified. | Partial. The ledger (on a JSONL file), reservations, trial credits and the `order.paid` webhook and BYOK (workspace pi sign-ins and multix keys; BYOK images cost no credits) exist; checkout, subscriptions, the PostgreSQL ledger, per-key limits and per-job margin reporting are planned ([BILLING.md](BILLING.md)). |

Also planned, without a phase yet: PostgreSQL repositories wired to
`DATABASE_URL`, OTLP trace export, per-job worker isolation, API key revocation,
and Motion IR migrations.

## V1 vertical slice

These criteria come from the bootstrap contract:

1. Over Streamable HTTP, `motion_create` accepts `{ brief }` (internal-opus)
   and `{ brief, creativeSpec }` (host-opus). It returns a project id and the
   job status.
2. The director stage produces a validated `TastePacket` and a Motion IR v0.1
   that is validated by zod, with the JSON Schema exported.
3. From that Motion IR, Pi or the deterministic compiler produces a HyperFrames
   project, and `hyperframes lint` passes on it.
4. A low-resolution preview and a final 1080p MP4 render locally, and FFmpeg
   finishing produces a web-optimized MP4.
5. Jev routing returns a structured decision with a configurable model id and a
   deterministic fallback.
6. Every run writes a hierarchical trace with cost fields.
7. The root `check`, `test`, `lint`, `typecheck` and `build` scripts pass. The
   tests cover schemas, routing, compile, the MCP protocol, redaction and
   ledger math.
8. The documentation set in [README.md](README.md) and the ADRs in
   [decisions/](decisions/README.md) exist.

The slice runs on the file-backed store and the file ledger, with local-disk or
R2 artifacts. It does not include PostgreSQL, full billing, hybrid search,
Taste Memory or the dashboard.

Production release goes to `app.motion.digitop.ai/mcp` through the deploy
workflow ([ADR 0011](decisions/0011-docker-cloudflare-deployment.md)).
