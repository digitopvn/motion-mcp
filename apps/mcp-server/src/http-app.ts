import { createHash, timingSafeEqual } from "node:crypto";
import { hostHeaderValidation } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { CallerContext, MotionService } from "@motion-mcp/pipeline";
import type { Logger } from "@motion-mcp/shared";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { authInfoFor, createMotionMcpHandler, SERVER_VERSION } from "./mcp-handler.ts";

/** Resolves a bearer token to a caller, or null when the token is unknown or revoked. */
export type ApiKeyVerifier = (token: string) => Promise<CallerContext | null>;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * Static keys from MOTION_API_KEYS map to the default workspace. Comparison is on hashes so
 * timing does not leak key length or prefix.
 */
export function staticKeyVerifier(keys: string[], workspaceId = "ws_default"): ApiKeyVerifier {
  const hashes = keys.filter(Boolean).map((k, i) => ({ hash: sha256(k), keyId: `static_${i}` }));
  return async (token) => {
    const h = sha256(token);
    const match = hashes.find((k) => timingSafeEqual(k.hash, h));
    return match ? { workspaceId, keyId: match.keyId } : null;
  };
}

/** Tries each verifier in order (e.g. database keys, then static keys). */
export function chainVerifiers(...verifiers: ApiKeyVerifier[]): ApiKeyVerifier {
  return async (token) => {
    for (const v of verifiers) {
      const caller = await v(token);
      if (caller) return caller;
    }
    return null;
  };
}

export interface HttpAppOptions {
  service: MotionService;
  verifyKey: ApiKeyVerifier;
  allowedHosts: string[];
  logger?: Logger;
  /** Development-only escape hatch: accept unauthenticated calls as this workspace. */
  anonymousWorkspaceId?: string;
  /**
   * Extra routes (artifacts, public videos, webhooks) mounted before the MCP route and before any body
   * parser, so a webhook route can read its raw body for signature verification.
   */
  mount?: (app: Express) => void;
  /** Maximum JSON-RPC request body; defaults to 4 MB. */
  jsonLimit?: string;
}

export function createHttpApp(opts: HttpAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  // DNS-rebinding protection: only the configured hostnames may address this server.
  app.use(hostHeaderValidation(opts.allowedHosts));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: SERVER_VERSION });
  });

  opts.mount?.(app);

  const node = toNodeHandler(createMotionMcpHandler(opts.service, opts.logger));

  const auth = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    let caller: CallerContext | null = null;
    if (token) caller = await opts.verifyKey(token).catch(() => null);
    else if (opts.anonymousWorkspaceId)
      caller = { workspaceId: opts.anonymousWorkspaceId, keyId: "anonymous" };
    if (!caller) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="motion-mcp", error="invalid_token"')
        .json({ error: "unauthorized", message: "Missing or invalid API key" });
      return;
    }
    (req as Request & { auth?: unknown }).auth = authInfoFor(caller, token);
    next();
  };

  app.all("/mcp", express.json({ limit: opts.jsonLimit ?? "4mb" }), auth, (req, res) => {
    void node(req, res, req.body);
  });

  return app;
}
