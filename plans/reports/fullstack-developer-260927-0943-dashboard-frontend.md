# Phase 2 (frontend) report: apps/dashboard

Status: DONE_WITH_CONCERNS

## What was built
`apps/dashboard` (`@motion-mcp/dashboard`): Vite 8 + React 19 + react-router 7 + TypeScript, plain CSS that reuses the marketing tokens (paper/ink/accent, Instrument Serif / Inter / JetBrains Mono), light and dark via `prefers-color-scheme`, reduced-motion aware, responsive to 375px (sidebar collapses to a Menu toggle under 56rem).

- Routes: `/login`, and inside the signed-in shell `/`, `/videos`, `/videos/new`, `/videos/:id`, `/search`, `/recipes`, `/keys`, `/billing`, `/settings`, plus a 404.
- Shell: sidebar nav, workspace name, balance/held credits, avatar menu (Settings, Sign out via `POST /api/auth/logout`), skip link, landmarks.
- Any 401 goes to `/login?next=<path>`; `next` is sanitised (same-origin path only, no `//`, no control chars, never `/login`).
- Login: GitHub button to `/api/auth/oauth/github/start?next=…`, email form only when `/api/auth/providers` says `email: true`, mapped `?error=` codes from the contract, link to motion.digitop.ai, auto-redirect when a session already exists.
- Overview: balance, held, 30-day usage, trial note, recent videos, MCP config card (`https://app.motion.digitop.ai/mcp`) with copy and key link.
- Videos: paginated list; New video form (internal-opus default, custom; duration, aspect ratio, quality, recipe prefill via `?recipe=`), live cost estimate from `/api/billing` prices. Detail: player (preview/final picker), progress polling every 3 s while queued/running, Render final, Publish (unlisted) with copyable link, versions, usage, QA issues, IR scenes, collapsible IR JSON, trace table with span tree (duration, cost, model calls, errors).
- Search grouped by type; Recipes CRUD with "Use recipe"; API keys list/create (secret shown once with copy and warning)/revoke with confirm; Usage and billing (usage by day and operation, ledger, prices, Buy credits disabled with an explanation when checkout is off); Settings (profile, workspace id, sign out).

## Files
- New: `apps/dashboard/**` (package.json, tsconfig.json, vite.config.ts, index.html, public/favicon.svg, README.md, src/**, test/api-client.test.ts, test/format.test.ts).
- Modified: root `tsconfig.json` (`jsx: react-jsx`, include `apps/*/src/**/*.tsx`) so root `pnpm typecheck` covers the TSX; `pnpm-lock.yaml` via `pnpm install`. `pnpm-workspace.yaml` already globs `apps/*`; `dist/` is already gitignored and biome-ignored.
- Plan: added "Additive fields requested by the frontend" (list items `createdAt`/`directorMode`, detail `qaIssues`, overview `trialCredits`); the backend contract details now include all three. Frontend types follow the backend's "Contract details" section.

## Verification
Run from the repo root in PowerShell on 2026-09-27.
- `pnpm lint` (biome check .): 198 files checked, no errors or warnings.
- `pnpm typecheck` and `pnpm --filter @motion-mcp/dashboard typecheck` are both clean.
- `pnpm test` (vitest unit project): 29 files passed, with 263 tests passed and 1 skipped. This includes `apps/dashboard/test/api-client.test.ts` and `format.test.ts` (15 dashboard tests). The full suite takes about 210 s.
- `pnpm --filter @motion-mcp/dashboard build` produces `apps/dashboard/dist/index.html` plus hashed assets: about 320 kB JS (98 kB gzip) and 19 kB CSS.
- `git check-ignore -v apps/dashboard/dist/index.html` matches `.gitignore:5:dist/`.
- I have not done a manual browser pass against the live backend, because the backend phase was still in progress.

## Concerns for the orchestrator
- SPA fallback must exclude `/v/` as a path segment, not the prefix `/v`, or `/videos` deep links will 404.
- CSP needs `font-src https://fonts.gstatic.com` (Google Fonts) and inline `style` attributes (progress bar width); `media-src` must allow the signed render URLs.
- Vite dev proxy rewrites `Origin` to `http://localhost:8787` for mutating requests, which also satisfies the backend's dev-origin allowance.
- Saved recipes only prefill the create form; the dashboard never sends `recipeId` to `motion_create`, because that field refers to domain-pack recipes.
