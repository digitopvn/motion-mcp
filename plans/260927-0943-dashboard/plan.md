# Dashboard at app.motion.digitop.ai

Status: released 2026-09-27 (fec9379); live GitHub sign-in awaits a manual check by a user · Created 2026-09-27

## Outcome
`https://app.motion.digitop.ai/` serves the account dashboard. Signed-out visitors see a login page; after GitHub sign-in a user lands in their own workspace and can manage videos, API keys, usage and recipes. `/mcp`, `/healthz`, `/artifacts/*`, `/v/*` and `/webhooks/polar` keep working unchanged.

## Decisions (assumptions recorded in auto mode)
- **Login:** GitHub OAuth (client id/secret in `.env`, verified valid). Email magic link via Resend is implemented but only enabled when `RESEND_API_KEY` and `EMAIL_FROM` are set; the current key is rejected by Resend, so production starts with GitHub only. Google is omitted (no credentials).
- **OAuth callback host:** the GitHub app's registered callback is `https://motion.digitop.ai/api/auth/oauth/github/callback`. GitHub requires the redirect host to match, so the marketing Worker answers `/api/auth/*` with a 302 to the same path and query on `app.motion.digitop.ai`, and proxies `/api/webhooks/polar` to the app (POST bodies cannot follow redirects). The app always sends `redirect_uri = GITHUB_CALLBACK_URL`.
- **Sessions:** opaque random token in cookie `mmcp_session` (HttpOnly, Secure in production, SameSite=Lax, host-only, 30 days). Only its sha256 is stored. Mutating `/api` requests must carry `Origin` matching `PUBLIC_BASE_URL` (CSRF).
- **Accounts:** a first login creates a user and a personal workspace (owner membership); the existing idempotent trial grant gives it `TRIAL_CREDITS`. Static `MOTION_API_KEYS` keep mapping to `ws_default`.
- **Frontend:** `apps/dashboard`, Vite + React + TypeScript + react-router, no UI kit; visual language follows `apps/marketing/public/css/site.css`. Built to `apps/dashboard/dist` and served by the MCP server with an SPA fallback.
- **Storage:** new repositories in `packages/database` on the existing file repository.

## API contract (`/api`, JSON, cookie session; 401 `{error:"unauthorized"}` when signed out)
| Method & path | Purpose |
|---|---|
| GET `/api/auth/providers` | `{github: bool, email: bool}` |
| GET `/api/auth/oauth/github/start?next=/path` | Sets state cookie, 302 to GitHub |
| GET `/api/auth/oauth/github/callback` | Exchanges code, creates session, 302 to `next` |
| POST `/api/auth/email/request` `{email,next?}` | Sends magic link (always 204) |
| GET `/api/auth/email/verify?token=` | Consumes link, creates session, 302 |
| POST `/api/auth/logout` | Deletes session, 204 |
| GET `/api/me` | `{user, workspace, credits:{balance,held}}` |
| GET `/api/overview` | Balance, recent projects, recent usage totals |
| GET `/api/projects?limit&cursor` · GET `/api/projects/:id` | Wraps `MotionService.listProjects/getProject` (renders with signed URLs, versions, job, trace summary, IR on request) |
| POST `/api/projects` | `motion_create` input (internal-opus default) |
| POST `/api/projects/:id/render` · POST `/api/renders/:id/publish` | Wrap `render` / `publish` |
| GET `/api/projects/:id/traces` · GET `/api/traces/:id` | Job traces (span tree, cost) |
| GET `/api/search?q=` | Wraps `motion_search` |
| GET/POST/DELETE `/api/keys[/:id]` | List (prefix only), create (plaintext returned once), revoke |
| GET `/api/usage?since&until` | Usage events + ledger entries |
| GET `/api/billing` · POST `/api/billing/checkout` | Balance, prices; Polar checkout URL when configured, else `{enabled:false}` |
| GET/POST/PATCH/DELETE `/api/recipes[/:id]` | Saved briefs/prompts (name, brief, directorMode, format, duration, quality, notes) |

### Additive fields requested by the frontend (phase 2; optional, the UI degrades without them)
- `ListProjects` items (projects list and `overview.recentProjects`): `createdAt`, `directorMode`. Without them the Videos table shows "Updated" and "—" for director.
- `GET /api/projects/:id`: `qaIssues: QaIssue[]` (latest version's open lint/check/vision issues). Without it the QA section reports none.
- `GET /api/overview`: `trialCredits` (the trial grant amount) for the trial note; without it a generic trial note shows while the workspace has no projects.

### Contract details (backend, phase 1)
- Errors: `{error, message, details?}` with the /mcp public codes; status 400 `invalid_input`, 401 `unauthorized`, 402 `insufficient_credits`/`budget_exceeded`, 404 `not_found`, 409 `conflict`, 429 `rate_limited`, 503 `provider_unavailable`, 500 `internal` (message "Internal error"). CSRF rejection is 403 `{error:"forbidden"}`; every non-GET `/api` call must send `Origin` (browsers do for `fetch` POST/PATCH/DELETE). In `NODE_ENV=development` any `http://localhost:*`/`127.0.0.1:*` origin is also accepted (Vite dev proxy).
- Auth failures redirect to `/login?error=<code>`: `state_mismatch`, `oauth_denied`, `oauth_failed`, `github_disabled`, `link_invalid`. `POST /api/auth/email/request` returns 400 for a malformed email, otherwise always 204.
- `GET /api/me` → `{user:{id,name,email?,avatarUrl?,createdAt}, workspace:{id,name,createdAt}, credits:{balance,held}}`.
- `GET /api/overview` → `{credits, trialCredits, projectCount, recentProjects:[ListProjects item], usage:{since,until,credits,events,byOperation:[{operation,quantity,credits}]}}` (last 30 days).
- `GET /api/projects?limit&cursor&status` → `motion_list_projects` output; items (here and in `overview.recentProjects`) also carry `createdAt` and `directorMode`. `GET /api/projects/:id?include=versions,renders,usage,trace,ir` → `motion_get_project` output plus `qaIssues` (the current version's issues from `motion_inspect`, `[]` before the first version); default include `versions,renders,usage,trace` (`ir` only on request).
- `POST /api/projects` body = `motion_create` input (directorMode defaults to `internal-opus` unless `creativeSpec` is given) → 202 `motion_create` output. `POST /api/projects/:id/render` body `{quality, version?, budgetCredits?}` → 202. `POST /api/renders/:id/publish` body `{projectId, visibility?}` → `motion_publish` output.
- `GET /api/projects/:id/traces` → `{traces:[{id,name,projectId,jobId,createdAt,summary}]}`; `GET /api/traces/:id` → `{trace:{...same, root}}` (root = span tree).
- `GET /api/search?q=&types=a,b&limit=` → `motion_search` output.
- `GET /api/keys` → `{keys:[{id,name,prefix,createdAt,revokedAt?}]}`; `POST /api/keys {name}` → 201 `{key:{...}, secret}` (`secret` is the plaintext `mmcp_...`, shown once); `DELETE /api/keys/:id` → 204.
- `GET /api/usage?since&until` (ISO datetimes, default last 30 days) → `{since,until,totals:{credits,events},events:[{id,projectId?,jobId?,operation,quantity,credits,byok,createdAt}],ledger:[{id,kind,operation?,reservationId?,availableDelta,heldDelta,metadata?,createdAt}]}`.
- `GET /api/billing` → `{credits, creditUsd, prices:[{operation,credits,unit}], checkout:{enabled}}`; `POST /api/billing/checkout` → `{enabled:false}` or `{enabled:true,url}` (needs `POLAR_ACCESS_TOKEN` + `POLAR_PRODUCT_ID`).
- Recipes: `GET /api/recipes` → `{recipes:[Recipe]}`; `POST` → 201 `{recipe}`; `GET/PATCH /api/recipes/:id` → `{recipe}` (PATCH: `null` clears an optional field); `DELETE` → 204. Recipe = `{id,workspaceId,name,brief,directorMode?,format?:{width?,height?,fps?,aspectRatio?},durationSeconds?,quality?,notes?,createdAt,updatedAt}`.
- The SPA is served for browser navigations outside `/mcp`, `/api`, `/artifacts`, `/v`, `/healthz`, `/webhooks`. CSP: scripts from self only; styles self + inline + Google Fonts; images/media self, `data:`/`blob:`, R2, `avatars.githubusercontent.com`; `connect-src 'self'`.

## Phases
1. Backend: database repos, config, auth, `/api`, static serving, marketing Worker forwarder, tests.
2. Frontend: `apps/dashboard` pages: Login, Overview, Videos (list, create, detail with player, versions, QA, IR, traces), Search, Recipes, API keys, Usage & billing, Settings.
3. Release: Dockerfile builds the dashboard, `.env.example`, VPS env (`GITHUB_*`), deploy, live verification.

Phases 1 and 2 run in parallel against this contract.

## Acceptance criteria
- `GET https://app.motion.digitop.ai/` returns the dashboard HTML; unauthenticated users see the login page.
- GitHub sign-in completes end to end and lands on Overview with the trial balance.
- A key created in the dashboard authenticates `/mcp` `tools/list`; revoking it returns 401.
- Videos list shows projects created through MCP with that key; detail plays the render.
- `pnpm check` green; CI and Deploy green.

## Non-goals (this round)
Editing inside an embedded HyperFrames Studio, team invites/multiple members, Google login, Taste Memory UI.
