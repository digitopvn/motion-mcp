import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { handlePolarWebhook } from "@motion-mcp/billing";
import { ARTIFACT_ROUTE, type PipelineRuntime, resolvePublishedRender } from "@motion-mcp/pipeline";
import { toMotionError } from "@motion-mcp/shared";
import express, { type Express, type Request, type Response } from "express";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".html": "text/plain; charset=utf-8",
};

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[key.slice(dot).toLowerCase()]) || "application/octet-stream";
}

/** Local store keys resolve to a validated path inside the storage root (the store rejects escapes). */
async function localPath(rt: PipelineRuntime, key: string): Promise<string | undefined> {
  if (rt.store.driver !== "local" || !(await rt.store.exists(key))) return undefined;
  return fileURLToPath(await rt.store.url(key));
}

/**
 * Streams a local artifact with range support. Artifacts are served as downloads-safe static content:
 * compositions are HTML generated from model output, so they are never rendered as HTML by the browser.
 */
function sendArtifact(res: Response, path: string, key: string, cacheControl: string): void {
  res.sendFile(
    path,
    {
      acceptRanges: true,
      dotfiles: "deny",
      headers: {
        "Content-Type": contentTypeFor(key),
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `inline; filename="${basename(key)}"`,
      },
    },
    (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "not_found" });
    },
  );
}

/** Public HTTP routes next to /mcp: signed local artifacts, published videos, and the Polar webhook. */
export function mountPublicRoutes(app: Express, rt: PipelineRuntime): void {
  const { logger } = rt;

  app.get(`${ARTIFACT_ROUTE}/*key`, async (req: Request, res: Response) => {
    const raw = (req.params as { key?: string | string[] }).key;
    const key = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
    if (!rt.signer.verify(key, req.query.exp, req.query.sig)) {
      res.status(403).json({ error: "forbidden", message: "Invalid or expired artifact URL" });
      return;
    }
    try {
      const path = await localPath(rt, key);
      if (!path) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      sendArtifact(res, path, key, "private, max-age=300");
    } catch (err) {
      logger.warn("artifacts.serve_failed", { message: toMotionError(err).message });
      res.status(404).json({ error: "not_found" });
    }
  });

  app.get("/v/:renderId", async (req: Request, res: Response) => {
    try {
      const published = await resolvePublishedRender(rt, String(req.params.renderId ?? ""));
      if (!published) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (published.visibility === "unlisted") res.set("X-Robots-Tag", "noindex");
      if (rt.store.driver !== "local") {
        res.redirect(302, await rt.store.url(published.key, { expiresIn: 3600 }));
        return;
      }
      const path = await localPath(rt, published.key);
      if (!path) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      sendArtifact(res, path, published.key, "public, max-age=3600");
    } catch (err) {
      logger.warn("publish.serve_failed", { message: toMotionError(err).message });
      res.status(404).json({ error: "not_found" });
    }
  });

  app.post(
    "/webhooks/polar",
    express.raw({ type: () => true, limit: "1mb" }),
    async (req: Request, res: Response) => {
      const secret = rt.config.POLAR_WEBHOOK_SECRET;
      if (!secret) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      try {
        const result = await handlePolarWebhook({ headers: req.headers, body, secret, ledger: rt.ledger });
        logger.info("polar.webhook", {
          type: result.type,
          handled: result.handled,
          transactionId: result.transaction?.id,
        });
        res.status(result.handled ? 200 : 202).json({ ok: true, handled: result.handled });
      } catch (err) {
        const e = toMotionError(err);
        const status = e.code === "UNAUTHORIZED" ? 401 : e.code === "VALIDATION" ? 400 : 500;
        logger.warn("polar.webhook_rejected", { code: e.code, message: e.message });
        res.status(status).json({ error: status === 500 ? "internal" : e.code.toLowerCase() });
      }
    },
  );
}
