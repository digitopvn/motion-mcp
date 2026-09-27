# Motion MCP server: Node 22 + FFmpeg + chrome-headless-shell for HyperFrames rendering.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HYPERFRAMES_NO_TELEMETRY=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_SKIP_SKILLS=1 \
    DATA_DIR=/data \
    PORT=8787

# FFmpeg for finishing, unzip for HyperFrames' managed Chrome download, plus the shared libraries
# chrome-headless-shell needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg unzip fonts-liberation fontconfig \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxext6 libx11-6 libxcb1 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 libexpat1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .

# Full install (tsx runs the TypeScript sources directly), then build the dashboard SPA it serves at /.
RUN pnpm install --frozen-lockfile --prod=false \
 && pnpm --filter @motion-mcp/dashboard build \
 && mkdir -p /data && chown node:node /data

# HyperFrames caches its managed Chrome under the runtime user's ~/.cache/hyperframes.
USER node
RUN pnpm --filter @motion-mcp/hyperframes-adapter exec hyperframes browser ensure
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "apps/mcp-server/src/main.ts"]
