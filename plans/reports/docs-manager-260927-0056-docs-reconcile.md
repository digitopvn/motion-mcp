# Docs reconcile report

Scope: bring `docs/**` and `README.md` in line with the code that has now landed. ADRs are append-only and
were not edited.

## Surfaces changed

- Rewritten: `docs/README.md`, `ARCHITECTURE.md`, `MCP_API.md`, `JEV_ROUTING.md`, `DIRECTOR_PROTOCOL.md`,
  `BILLING.md`, `AGENT_RUNTIME.md`, `OBSERVABILITY.md`, `SECURITY.md`, `SEARCH.md`, `MOTION_IR.md`,
  `ROADMAP.md`.
- Edited: `docs/PRODUCT.md` and root `README.md`.
  - `custom` mode is now marked reserved/rejected.
  - A supplied spec selects host-opus.
  - Added the `keys create --name` command.
- Retained: `docs/decisions/*`. The `ARCHITECTURE.md#data-model` anchor that ADR 0009 links to was
  restored as a subheading.

## Key claims and evidence (source)

- **Config** (`packages/shared/src/config.ts`):
  - MAX_REVISION_LOOPS defaults to 2 (maximum 5).
  - JOB_CONCURRENCY defaults to 1.
  - TRIAL_CREDITS defaults to 500.
  - ARTIFACT_SIGNING_SECRET has fallbacks.
  - POLAR_ENVIRONMENT defaults to sandbox and is unused.
- **Director mode resolution:**
  - Order: explicit mode, then creativeSpec (selects host-opus), then DEFAULT_DIRECTOR_MODE.
  - `custom` is rejected.
  - The handshake happens via `motion_inspect`.
- **Jev:**
  - One question per `decide` call.
  - Chain: TypeSafe (only when a key is set), then the OpenRouter LLM, then rules.
  - Each decision writes a `jev.route` span.
- **HTTP routes:** `/healthz`, `/mcp` (bearer), `/artifacts/*` (HMAC), `/v/:renderId` (range),
  `POST /webhooks/polar`. There is also a host allow-list.
- **CLI** (`apps/mcp-server/src/cli.ts`): `create`, `render`, `doctor`, `schema`, `keys create`.
- **Errors:** the mapping comes from `PUBLIC_ERROR_CODES`.
- **Billing:**
  - Prices are linked to `packages/billing/src/prices.ts` and `motion_inspect`, not copied.
  - The ledger is a JSONL file.
  - Only `order.paid` grants credits.
- **Deployment:** links to `Dockerfile`, `docker-compose.yml`, `ci.yml`, `deploy.yml` and
  `apps/marketing/wrangler.jsonc`.
  - The app is bound to 127.0.0.1:8787.
  - The image is published to GHCR.
  - A Cloudflare Tunnel serves `app.motion.digitop.ai`, and Workers serve the marketing site.
- **Planned, not shipped:**
  - PostgreSQL repositories, OTLP, PII redaction, the polish stage, `custom` mode.
  - BYOK, checkout and subscriptions, rate limits.
  - Media generation wiring, the dashboard, hybrid search and Taste Memory, IR migrations.

## Validation

- **Anchors:** every in-docs `#anchor` link resolves to an existing heading. The one broken anchor,
  ADR 0009 → `#data-model`, was fixed.
- **Relative links:** every relative link target exists, including `../Dockerfile`, the compose file,
  both workflows, `wrangler.jsonc` and `fixtures/golden/*/creative-spec.json`.
- **Stale wording:** no "not landed" or "only research" wording remains.
- **Length:** every doc is under 800 lines. The largest is `ARCHITECTURE.md` at about 178 lines.
- **Not run:** `pnpm check`, because only docs changed.

## Code concerns (not fixed; outside docs scope)

- A `runtime_error` issue can escalate to Opus after 2 cheap attempts, because `implementation` is in
  OPUS_FIXABLE. Check that this is intended.
- `POLAR_ENVIRONMENT` and `POLAR_ACCESS_TOKEN` are declared but unused. `recipeId` is accepted but unused.
- The redactor does not register `DATABASE_URL` by name, and there is no PII redaction.
- The runtime does not match ADR 0011 in two places: compose has no Postgres service, and the image has no
  ImageMagick.
