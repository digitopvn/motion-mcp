# Phase 07 — Release: Docker, CI/CD, deploy, marketing

## Context
Depends on phase 06. VPS facts from the contract: `ssh -p 52022 dev@159.195.110.182`, no Docker group access for `dev` yet (user must run `sudo usermod -aG docker dev`), nothing listening on 80/443, FFmpeg absent on the host.

## Files owned
`Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/*`, `apps/marketing/**`, `README.md`, `.env.example`, `LICENSE`.

## Requirements
- Dockerfile: Node 22 slim, pnpm, FFmpeg, fonts, chrome-headless-shell via `hyperframes browser ensure`, non-root user, `/data` volume, healthcheck on `/healthz`.
- docker-compose: `app` service plus a `cloudflared` tunnel service (token from `.env`), routing `app.motion.digitop.ai` → `app:8787`.
- CI (`ci.yml`): install, lint, typecheck, unit tests — no frontier-model calls. Deploy (`deploy.yml`) on push to `main`: build and push the image to GHCR, then SSH to the VPS and run `docker compose pull && up -d`. Secrets come from GitHub Actions secrets.
- Marketing site: static Cloudflare Workers assets site in `apps/marketing` deployed with wrangler to `motion.digitop.ai`.
- Create the `digitopvn/motion-mcp` repository (public, MIT) and push.
- Live verification: `tools/list` on `https://app.motion.digitop.ai/mcp` returns exactly the 8 public tools.

## Risks and rollback
Deploy is blocked until Docker access is granted; the tunnel token and DNS need Cloudflare access. Rollback: redeploy the previous image tag.
