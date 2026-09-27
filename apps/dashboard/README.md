# @motion-mcp/dashboard

Account dashboard served at `https://app.motion.digitop.ai/` by the MCP server (SPA fallback). Vite + React +
react-router, plain CSS that reuses the marketing site's tokens (`apps/marketing/public/css/site.css`).

```sh
pnpm --filter @motion-mcp/mcp-server dev      # API on http://localhost:8787
pnpm --filter @motion-mcp/dashboard dev       # http://localhost:5173, proxies /api /mcp /artifacts /v/ to :8787
pnpm --filter @motion-mcp/dashboard build     # -> apps/dashboard/dist (hashed assets)
```

The `/api` contract lives in `plans/260927-0943-dashboard/plan.md`; the response types used here are in
`src/lib/types.ts`. Unit tests for the pure helpers are in `test/` and run with the root `pnpm test`.
