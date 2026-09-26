---
status: in-progress
created: 2026-09-26
contract: ../reports/brainstorm-260926-2229-bootstrap-contract.md
architecture: ../reports/architecture-260926-2229-synthesis.md
---

# Motion MCP — Vertical Slice Plan

Goal: prove `motion_create → creative spec (host or internal Opus) → Motion IR → Pi/deterministic implementation → HyperFrames lint/check/snapshot → Jev route → preview → final MP4 → FFmpeg finish` end to end, exposed over Streamable HTTP MCP and deployed to `app.motion.digitop.ai/mcp`.

| Phase | Scope | Owner | Status |
|---|---|---|---|
| 01 | Core schemas: shared, motion-ir, observability | main | done |
| 02 | HyperFrames adapter + FFmpeg helpers | agent A | pending |
| 03 | LLM client, Director, Jev router | agent B | pending |
| 04 | Pi runtime + media (multix, capability matrix, prices) | agent C | pending |
| 05 | Domain pack, billing ledger, storage, database | agent D | pending |
| 06 | Pipeline orchestrator + MCP server + CLI | main | done |
| 07 | E2E verification, Docker, CI/CD, deploy, marketing | main | pending |
| 08 | Docs (12 docs + ADRs) | docs agent | in progress |

Dependencies: 02–05 depend only on 01 and run in parallel with disjoint file ownership. 06 depends on 02–05. 07 depends on 06.

## Acceptance criteria

See the contract. Key gates: `pnpm check` green; golden fixtures compile and lint clean; a real 1080p MP4 is produced locally from a brief in both director modes; MCP protocol tests pass in-process; live endpoint answers `tools/list` with exactly 8 public tools.

## Phase details

- [phase-02-hyperframes-adapter.md](phase-02-hyperframes-adapter.md)
- [phase-03-director-jev.md](phase-03-director-jev.md)
- [phase-04-pi-runtime-media.md](phase-04-pi-runtime-media.md)
- [phase-05-domain-pack-billing-storage.md](phase-05-domain-pack-billing-storage.md)
- [phase-06-pipeline-mcp-server.md](phase-06-pipeline-mcp-server.md)
- [phase-07-release.md](phase-07-release.md)
