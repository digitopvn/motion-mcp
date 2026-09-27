# Dashboard backend (phase 1) report

Status: done. `pnpm check` passes from the repo root: Biome checked 198 files cleanly, `tsc` reported no errors, and vitest passed 29 files and 263 tests with 1 skipped.

## What was built
- **Database** (`packages/database`): new entities `User`, `Workspace`, `Session`, `LoginToken` and `Recipe`, each with a file-repository implementation that uses the existing per-file lock. Session and login-token ids are derived from the token hash, so a hash lookup is one file read. `loginTokens.consume` is atomic and works exactly once, which is covered by a concurrency test.
- **Config** (`packages/shared/src/config.ts`): added `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` (defaults to the motion.digitop.ai callback), `RESEND_API_KEY`, `EMAIL_FROM`, `DASHBOARD_DIST` and `POLAR_PRODUCT_ID`. The secrets are registered for redaction. `.env.example` is updated.
- **Billing**: added `createPolarCheckout` (Polar REST called through `fetch`; the workspace is passed in checkout metadata so the existing `order.paid` webhook grants the credits) and `CreditLedger.transactions()` for the usage history.
- **mcp-server**:
  - `dashboard-auth.ts`: sessions, GitHub OAuth, email magic link and logout.
  - `dashboard-api.ts`: the `/api` routes.
  - `dashboard-http.ts`: errors, cookies, `next` sanitising and the rate limiter.
  - `github-oauth.ts` and `email-login.ts`: the GitHub and Resend calls.
  - `dashboard-static.ts`: serves the SPA, its CSP and the 503 note shown when the dashboard is not built.
  - `buildApp(rt, {fetch?})` mounts all of these. `PUBLIC_ERROR_CODES` is now exported from `mcp-handler.ts`, and the startup doctor log now reports which dashboard providers are enabled.
- **Marketing Worker**: `apps/marketing/src/worker.ts`. `wrangler.jsonc` now has `main`, the `ASSETS` binding, `run_worker_first: ["/api/*"]` and an `APP_ORIGIN` var. Wrangler stays pinned at 4.141.0. The root `tsc` typechecks the Worker using only DOM types.

## What the frontend needs to know
- Response shapes are in `plans/260927-0943-dashboard/plan.md` under "Contract details (backend, phase 1)". Paths are unchanged.
- The frontend's additive requests are all implemented:
  - List items carry `createdAt` and `directorMode`.
  - `GET /api/projects/:id` returns `qaIssues`.
  - `GET /api/overview` returns `trialCredits`.
- Every non-GET `/api` call must send an `Origin` header matching `PUBLIC_BASE_URL`. In development, `http://localhost:*` origins are also accepted. A CSRF rejection returns 403 `{error:"forbidden"}`.
- Signed-out calls return 401 `{error:"unauthorized"}`.
- Login failures redirect to `/login?error=state_mismatch|oauth_denied|oauth_failed|github_disabled|link_invalid`.
- Start GitHub login with a full-page navigation to `/api/auth/oauth/github/start?next=<path>`. `next` must be a same-origin relative path; anything else becomes `/`.
- `POST /api/keys` returns `{key, secret}`. `secret` is the plaintext key and is only ever returned once.
- `POST /api/renders/:id/publish` needs `{projectId}` in the body.
- `POST /api/projects` returns 202 and defaults to `internal-opus`.
- The CSP allows scripts from self only, so the frontend must not use inline scripts. Inline styles and Google Fonts are allowed.

## Tests
- New or changed test files:
  - `packages/database/test/database.test.ts`
  - `packages/shared/test/config.test.ts`
  - `packages/billing/test/polar-checkout.test.ts`
  - `apps/mcp-server/test/dashboard-api.test.ts` (runs on a real harness with GitHub and Resend replaced by a fake `fetch`)
  - `apps/mcp-server/test/marketing-worker.test.ts`
- These cover:
  - The OAuth callback creates the user, workspace, trial credits and session cookie.
  - A second login reuses the account without a second trial grant.
  - A mismatched state is rejected, and a code GitHub refuses fails closed.
  - `next` is sanitised.
  - The email link works exactly once.
  - Logout deletes the session.
  - CSRF requests are rejected with 403.
  - A dashboard key passes `/mcp` `tools/list`, and after it is revoked `/mcp` returns 401.
  - Recipes CRUD works, and access from another workspace returns 404.
  - Error codes map correctly.
  - The SPA fallback does not shadow `/mcp`, `/api`, `/healthz`, `/v` or `/artifacts`.
  - `/` returns the 503 note when the dashboard is not built.
  - The Worker redirects auth routes, proxies the Polar webhook and returns 404 for other `/api` paths.

## Notes and open questions
- If an email scanner prefetches a magic link, it uses up that single-use token (as the contract requires, `/verify` is a GET). This only matters once Resend is enabled.
- The dashboard's "Buy credits" checkout needs a new `POLAR_PRODUCT_ID` (a Polar product) set in the VPS env in phase 3. Until it is set, `/api/billing/checkout` returns `{enabled:false}`.
- Phase 3 must set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the VPS, keep `PUBLIC_BASE_URL=https://app.motion.digitop.ai`, and deploy the marketing Worker so the OAuth callback redirect exists.
