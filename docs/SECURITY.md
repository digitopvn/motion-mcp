# Security

This document covers what Motion MCP protects: provider credentials, platform
API keys, tenant projects and assets, and the host machine that runs untrusted,
model-written HTML. Each section says what is enforced in code today and what
is still **planned**.

## Secrets

- Secrets never enter prompts, tool results, task text, logs, traces or git.
  Models receive capabilities, meaning tools, and never keys.
- `.env` exists only on local machines and on the VPS, and is ignored by git.
  Deployment secrets flow through GitHub Actions secrets and the VPS `.env`.
- CI never calls paid frontier models. Live-model tests run only through the
  opt-in `pnpm test:live` project.
- Documentation never contains secret values, tokenized URLs or customer data.

## Provider credentials (BYOK)

**Planned.** Workspace provider keys would be stored in `provider_credentials`
with authenticated encryption (the table is defined in the drizzle schema). The
data-encryption key would be held outside the database, in the runtime secret
store, with `key_version` for rotation and `last4` for display. Keys would be
decrypted in memory only for the call that needs them and passed to a child
process through its environment, never through argv or files.

## Redaction

The shared redactor in `packages/shared/src/redact.ts` is the authority for
what is masked. It combines two mechanisms:

- **Value-based.** At startup every environment variable whose name contains
  `KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL` is registered, along
  with the configured provider, storage, Polar and signing secrets. Registered
  values are scrubbed verbatim wherever they appear.
- **Pattern-based.** Bearer and Basic credentials, common provider key shapes
  (including OpenRouter `sk-or-…`, Polar tokens and Motion MCP `mmcp_` keys),
  JWTs, PEM private keys, signed-URL signature parameters, and secret-looking
  key/value pairs.

It runs on traces before they are stored, on public error details, on job error
messages, on decision state sent to Jev adapters, and on provider error bodies.
Its unit tests are in `packages/shared/test/redact.test.ts`.

Gaps: `DATABASE_URL` is not registered by name, and email addresses and other
personal data in free text are not redacted. Both are **planned**.

## MCP authentication

- `/mcp` requires `Authorization: Bearer <api key>`, and a missing or unknown
  key gets 401 before any tool runs.
- Workspace keys come from `pnpm motion keys create`: `mmcp_` plus 256 random
  bits, shown once. Only the SHA-256 hash and a short display prefix are stored,
  and lookups ignore revoked keys. A revocation command is **planned**.
- Static keys from `MOTION_API_KEYS` map to the default workspace and are
  compared as hashes in constant time.
- Unauthenticated access exists only with `NODE_ENV=development` and no static
  keys, and the server logs a warning when it is on.
- Each key is scoped to one workspace, and every project lookup checks that the
  project belongs to the caller's workspace. A project in another workspace is
  reported as `not_found`.
- OAuth (MCP authorization with resource metadata) is not in v1.

## DNS rebinding

The HTTP app validates the `Host` header on every route against
`ALLOWED_HOSTS` plus the host of `PUBLIC_BASE_URL`, and rejects any other host
with 403.

## Artifact URLs and published renders

- Local-storage artifacts are reachable only through `/artifacts/*` URLs signed
  with HMAC-SHA256 over the key and expiry, checked in constant time, and
  capped in lifetime. The secret is `ARTIFACT_SIGNING_SECRET`; see
  [ARCHITECTURE.md](ARCHITECTURE.md#configuration) for its fallbacks. With R2,
  clients get presigned R2 URLs instead.
- Storage keys are validated against a strict pattern, and the local store
  rejects any key that escapes its root.
- Artifacts are served with `nosniff`, a `sandbox` Content Security Policy and
  an inline disposition, and compositions are served as plain text, so
  model-written HTML never executes in a viewer's browser.
- Only succeeded final renders can be published at `/v/<renderId>`. Unlisted
  renders carry `X-Robots-Tag: noindex`.

## Polar webhooks

The webhook route reads the raw body and verifies the Standard Webhooks
signature against `POLAR_WEBHOOK_SECRET` in constant time, with a five-minute
replay window. Grants are idempotent per order id. The route returns 404 when
no secret is configured.

## Pi isolation

Pi's `cwd` is not a sandbox, so these controls apply
([AGENT_RUNTIME.md](AGENT_RUNTIME.md#isolation)):

- Pi runs inside the production container as the non-root `node` user.
- Shell tools are not granted, and a path-guard extension limits file tools to
  the project directory and limits writes to the scene's own composition file.
- Pi's resource discovery is disabled: a private agent directory, no
  extensions, skills or context files from the user or the project.
- Generated HTML is untrusted. It is linted, checked and rendered only inside
  the pipeline, and it is never fed from raw user text into code-bearing
  HyperFrames inputs.
- **Planned:** per-job container or mount isolation, so that the only writable
  path is the job's own directory.

## No public shell

No public tool, and no tool granted to Pi, executes arbitrary commands. FFmpeg,
HyperFrames and multix are invoked with `execFile`-style argv arrays built from
typed parameters, with a scrubbed environment.

## multix environment scrubbing

multix loads keys from `process.env`, then from `<cwd>/.env`, then from
`~/.multix/.env`. A `.env` file planted in a user-controlled directory could
inject keys, base URLs or model overrides. The runner in `packages/media`
defends against this ([ADR 0007](decisions/0007-multix-cli-runner.md)):

- It runs multix in a fresh, runner-owned temporary directory that never
  contains a `.env` file.
- It builds the child's environment from a scrubbed base plus only the keys the
  chosen provider needs, `MULTIX_OUTPUT_DIR`, `NO_COLOR` and
  `MULTIX_DISABLE_HOME_ENV=1`.
- It refuses `multix check` and `multix update`, and computes key availability
  itself.
- It passes model-authored text as `--flag=value` or after `--`, so text cannot
  inject options, and it accepts only real files inside the output directory.

The runner is implemented and tested, but the pipeline does not call it yet;
asset generation is **planned** ([ROADMAP.md](ROADMAP.md)).

## Third-party telemetry and egress

- HyperFrames runs with `HYPERFRAMES_NO_TELEMETRY=1` and
  `HYPERFRAMES_NO_UPDATE_CHECK=1`, set both in the adapter and in the image
  ([ADR 0005](decisions/0005-hyperframes-hybrid-integration.md)).
- `hyperframes snapshot` is always called with `--describe false`, so frames
  are never sent to a vision provider implicitly.
- Compositions vendor GSAP and embed their fonts, so a render fetches nothing.
