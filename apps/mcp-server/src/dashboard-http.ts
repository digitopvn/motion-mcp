import { type Logger, MotionError, redactDeep, toMotionError } from "@motion-mcp/shared";
import type { Request, Response } from "express";
import { z } from "zod";
import { PUBLIC_ERROR_CODES } from "./mcp-handler.ts";

/** HTTP status per public error code (the same codes /mcp tools return). */
const STATUS_BY_CODE: Record<string, number> = {
  invalid_input: 400,
  unauthorized: 401,
  insufficient_credits: 402,
  budget_exceeded: 402,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  provider_unavailable: 503,
  internal: 500,
};

/** Writes `{error, message, details?}`; internal failures never leak their message or details. */
export function sendApiError(res: Response, err: unknown, logger?: Logger): void {
  const e =
    err instanceof z.ZodError
      ? new MotionError("VALIDATION", "Invalid request", { details: { issues: err.issues.slice(0, 20) } })
      : toMotionError(err);
  const code = PUBLIC_ERROR_CODES[e.code] ?? "internal";
  const status = STATUS_BY_CODE[code] ?? 500;
  if (status >= 500) logger?.error("dashboard.api_error", { code: e.code, message: e.message });
  if (res.headersSent) return;
  res.status(status).json({
    error: code,
    message: code === "internal" ? "Internal error" : e.message,
    ...(e.details && code !== "internal" ? { details: redactDeep(e.details) } : {}),
  });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  path?: string;
  secure: boolean;
}

/** HttpOnly, SameSite=Lax, host-only cookie. A max age of 0 clears it. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.maxAgeSeconds <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function appendSetCookie(res: Response, cookie: string): void {
  res.append("Set-Cookie", cookie);
}

const MAX_NEXT_LENGTH = 500;

/**
 * Reduce a caller-supplied post-login destination to a same-origin relative path. Anything that could
 * leave the origin (absolute URLs, protocol-relative `//host`, backslash tricks, control characters) or
 * is not a string falls back to `/`.
 */
export function sanitizeNext(value: unknown, baseUrl: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NEXT_LENGTH) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "/";
  }
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.origin !== base.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return "/";
  }
}

/** Client address for rate limiting: Cloudflare's header when present (the app sits behind a tunnel). */
export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  const value = Array.isArray(cf) ? cf[0] : cf;
  return (value?.trim() || req.socket.remoteAddress || "unknown").slice(0, 64);
}

/** Fixed-window in-memory limiter keyed by string; old windows are pruned lazily. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; returns false when the key is over its limit for the current window. */
  allow(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
