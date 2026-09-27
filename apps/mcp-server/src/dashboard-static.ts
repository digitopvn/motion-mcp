import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MotionConfig } from "@motion-mcp/shared";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

/** Server-owned path prefixes the SPA fallback must never answer. */
export const RESERVED_PREFIXES = ["/mcp", "/api", "/artifacts", "/v", "/healthz", "/webhooks"] as const;

const DEFAULT_DIST = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));

export function dashboardDistDir(config: Pick<MotionConfig, "DASHBOARD_DIST">): string {
  return config.DASHBOARD_DIST ? resolve(config.DASHBOARD_DIST) : DEFAULT_DIST;
}

function isReserved(path: string): boolean {
  return RESERVED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSP for the dashboard shell: own scripts only; images and media from self, object storage (signed R2
 * URLs and the public bucket) and GitHub avatars; Google Fonts to match the marketing site; no framing.
 */
export function dashboardCsp(config: Pick<MotionConfig, "R2_PUBLIC_BASE_URL">): string {
  const storage = ["https://*.r2.cloudflarestorage.com", originOf(config.R2_PUBLIC_BASE_URL)]
    .filter(Boolean)
    .join(" ");
  return [
    "default-src 'self'",
    // Cloudflare injects its Web Analytics beacon at the edge.
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: blob: ${storage} https://avatars.githubusercontent.com`,
    `media-src 'self' blob: ${storage}`,
    "connect-src 'self' https://cloudflareinsights.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://github.com",
    "frame-ancestors 'none'",
  ].join("; ");
}

const UNAVAILABLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Motion MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem">
<h1>Dashboard unavailable</h1>
<p>The dashboard has not been built on this server. The MCP endpoint at <code>/mcp</code> is unaffected.</p>
</body></html>
`;

/**
 * Serves the built dashboard: hashed `/assets/*` with a long immutable cache, `index.html` with no-cache and
 * security headers, and the SPA shell for any other browser navigation outside the reserved prefixes.
 * When the build is missing, navigations get a small 503 page instead of "Cannot GET /".
 */
export function mountDashboardStatic(app: Express, config: MotionConfig): void {
  const dist = dashboardDistDir(config);
  const indexPath = join(dist, "index.html");
  const csp = dashboardCsp(config);

  const htmlHeaders = (res: Response) => {
    res.set({
      "Cache-Control": "no-cache",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  };

  const assets = express.static(dist, {
    index: false,
    dotfiles: "ignore",
    fallthrough: true,
    setHeaders: (res, path) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized.endsWith(".html")) htmlHeaders(res);
      else if (normalized.includes("/assets/"))
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      else res.set("Cache-Control", "public, max-age=3600");
      res.set("X-Content-Type-Options", "nosniff");
    },
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || isReserved(req.path)) {
      next();
      return;
    }
    if (req.path === "/index.html" || !existsSync(indexPath)) {
      next();
      return;
    }
    assets(req, res, next);
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || isReserved(req.path)) {
      next();
      return;
    }
    if (req.path !== "/" && !String(req.headers.accept ?? "").includes("text/html")) {
      next();
      return;
    }
    if (!existsSync(indexPath)) {
      res
        .status(503)
        .set({ "Cache-Control": "no-store", "Retry-After": "300" })
        .type("html")
        .send(UNAVAILABLE_HTML);
      return;
    }
    htmlHeaders(res);
    res.sendFile(indexPath, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
}
