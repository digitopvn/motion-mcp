import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { KeyedMutex, type Session, type User, type Workspace } from "@motion-mcp/database";
import type { CallerContext, PipelineRuntime } from "@motion-mcp/pipeline";
import { MotionError, registerSecret, toMotionError } from "@motion-mcp/shared";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import {
  appendSetCookie,
  clientIp,
  parseCookies,
  RateLimiter,
  sanitizeNext,
  sendApiError,
  serializeCookie,
} from "./dashboard-http.ts";
import { sendMagicLinkEmail } from "./email-login.ts";
import { fetchGithubProfile, type GithubOAuthConfig, githubAuthorizeUrl } from "./github-oauth.ts";

export const SESSION_COOKIE = "mmcp_session";
export const OAUTH_STATE_COOKIE = "mmcp_oauth";
const OAUTH_COOKIE_PATH = "/api/auth/oauth/github";
const OAUTH_STATE_TTL_S = 10 * 60;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often, so a busy session does not write on every request. */
const SESSION_REFRESH_MS = 60 * 60 * 1000;
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_LENGTH = 200;

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A signed-in dashboard caller: the user, their personal workspace and the MotionService caller. */
export interface DashboardIdentity {
  user: User;
  workspace: Workspace;
  session: Session;
  caller: CallerContext;
}

export interface AuthProviders {
  github: boolean;
  email: boolean;
}

interface AccountProfile {
  githubId?: string;
  email?: string;
  name: string;
  avatarUrl?: string;
}

const EmailRequestBody = z.object({
  email: z.email().max(320),
  next: z.string().max(500).optional(),
});

/**
 * Cookie sessions, account provisioning and the `/api/auth/*` routes (GitHub OAuth, email magic link,
 * logout). Only token hashes are stored; the plaintext session token lives in the HttpOnly cookie.
 */
export class DashboardAuth {
  private readonly accounts = new KeyedMutex();
  private readonly emailPerAddress = new RateLimiter(3, 15 * 60 * 1000);
  private readonly emailPerIp = new RateLimiter(10, 15 * 60 * 1000);
  private readonly secure: boolean;
  private readonly baseUrl: string;

  constructor(
    private readonly rt: PipelineRuntime,
    private readonly fetchImpl: typeof fetch,
  ) {
    const { config } = rt;
    this.secure = config.NODE_ENV === "production";
    this.baseUrl = config.PUBLIC_BASE_URL.replace(/\/+$/, "");
    registerSecret(config.GITHUB_CLIENT_SECRET);
    registerSecret(config.RESEND_API_KEY);
  }

  providers(): AuthProviders {
    const { config } = this.rt;
    return {
      github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
      email: Boolean(config.RESEND_API_KEY && config.EMAIL_FROM),
    };
  }

  private github(): GithubOAuthConfig | undefined {
    const { config } = this.rt;
    if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) return undefined;
    return {
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
      callbackUrl: config.GITHUB_CALLBACK_URL,
      fetch: this.fetchImpl,
    };
  }

  private sessionCookie(token: string, maxAgeMs: number): string {
    return serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: maxAgeMs / 1000, secure: this.secure });
  }

  /** Resolve the session cookie to an identity, sliding the session's expiry forward when due. */
  async resolve(req: Request, res: Response): Promise<DashboardIdentity | undefined> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length > MAX_TOKEN_LENGTH) return undefined;
    const { repos } = this.rt;
    let session = await repos.sessions.findByTokenHash(sha256Hex(token));
    if (!session) return undefined;
    const user = await repos.users.get(session.userId);
    if (!user) {
      await repos.sessions.delete(session.id);
      return undefined;
    }
    const now = Date.now();
    if (now - Date.parse(session.lastSeenAt) > SESSION_REFRESH_MS) {
      session = await repos.sessions.touch(session.id, {
        lastSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      });
      appendSetCookie(res, this.sessionCookie(token, SESSION_TTL_MS));
    }
    const workspace = await this.ensureWorkspace(user);
    return {
      user,
      workspace,
      session,
      caller: { workspaceId: workspace.id, keyId: `user_${user.id}` },
    };
  }

  private async startSession(res: Response, userId: string): Promise<void> {
    const token = newToken();
    await this.rt.repos.sessions.create({
      userId,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
    appendSetCookie(res, this.sessionCookie(token, SESSION_TTL_MS));
  }

  private async endSession(req: Request, res: Response): Promise<void> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token && token.length <= MAX_TOKEN_LENGTH) {
      const session = await this.rt.repos.sessions.findByTokenHash(sha256Hex(token));
      if (session) await this.rt.repos.sessions.delete(session.id);
    }
    appendSetCookie(res, this.sessionCookie("", 0));
  }

  /** The user's personal workspace, created (with the one-time trial grant) on first use. */
  private ensureWorkspace(user: User): Promise<Workspace> {
    return this.accounts.run(`workspace:${user.id}`, async () => {
      const { repos, ledger, config } = this.rt;
      const existing = (await repos.workspaces.listByOwner(user.id))[0];
      if (existing) return existing;
      const workspace = await repos.workspaces.create({
        name: `${user.name}'s workspace`.slice(0, 200),
        ownerUserId: user.id,
      });
      if (config.TRIAL_CREDITS > 0) {
        // Same idempotency key as the pipeline's trial grant, so the workspace is granted exactly once.
        await ledger.grant({
          workspaceId: workspace.id,
          credits: config.TRIAL_CREDITS,
          source: "trial",
          idempotencyKey: `trial:${workspace.id}`,
          metadata: { reason: "early-access trial" },
        });
      }
      this.rt.logger.info("dashboard.workspace_created", { userId: user.id, workspaceId: workspace.id });
      return workspace;
    });
  }

  /**
   * Find the account for a login identity, or create it. A GitHub id always wins; a verified email links
   * to an existing account that has no GitHub identity yet.
   */
  private async upsertUser(profile: AccountProfile): Promise<User> {
    const user = await this.accounts.run("accounts", async () => {
      const { users } = this.rt.repos;
      let found = profile.githubId ? await users.findByGithubId(profile.githubId) : undefined;
      let emailTaken = false;
      if (!found && profile.email) {
        const byEmail = await users.findByEmail(profile.email);
        if (byEmail && (!profile.githubId || !byEmail.githubId)) found = byEmail;
        else if (byEmail) emailTaken = true;
      }
      if (found) {
        if (!profile.githubId) return found;
        return users.update(found.id, {
          githubId: profile.githubId,
          name: profile.name,
          avatarUrl: profile.avatarUrl ?? found.avatarUrl,
          email: found.email ?? profile.email,
        });
      }
      return users.create({
        name: profile.name,
        email: emailTaken ? undefined : profile.email,
        avatarUrl: profile.avatarUrl,
        githubId: profile.githubId,
      });
    });
    await this.ensureWorkspace(user);
    return user;
  }

  private loginFailed(res: Response, code: string): void {
    res.redirect(302, `/login?error=${encodeURIComponent(code)}`);
  }

  /** `/api/auth/*` routes. CSRF (Origin) checks for the POST routes are applied by the enclosing router. */
  routes(): Router {
    const router = express.Router();
    const { logger } = this.rt;

    router.get("/providers", (_req, res) => {
      res.json(this.providers());
    });

    router.get("/oauth/github/start", (req, res) => {
      const github = this.github();
      if (!github) {
        this.loginFailed(res, "github_disabled");
        return;
      }
      const state = newToken();
      const next = sanitizeNext(queryString(req.query.next), this.baseUrl);
      appendSetCookie(
        res,
        serializeCookie(OAUTH_STATE_COOKIE, `${state}.${Buffer.from(next).toString("base64url")}`, {
          maxAgeSeconds: OAUTH_STATE_TTL_S,
          path: OAUTH_COOKIE_PATH,
          secure: this.secure,
        }),
      );
      res.set("Cache-Control", "no-store");
      res.redirect(302, githubAuthorizeUrl(github, state));
    });

    router.get("/oauth/github/callback", async (req, res) => {
      const stored = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE] ?? "";
      appendSetCookie(
        res,
        serializeCookie(OAUTH_STATE_COOKIE, "", {
          maxAgeSeconds: 0,
          path: OAUTH_COOKIE_PATH,
          secure: this.secure,
        }),
      );
      res.set("Cache-Control", "no-store");
      const github = this.github();
      if (!github) return this.loginFailed(res, "github_disabled");
      if (queryString(req.query.error)) return this.loginFailed(res, "oauth_denied");

      const dot = stored.indexOf(".");
      const expected = dot > 0 ? stored.slice(0, dot) : "";
      const state = queryString(req.query.state) ?? "";
      if (!expected || !state || !safeEqual(expected, state)) {
        logger.warn("dashboard.oauth_state_mismatch", { hasCookie: Boolean(stored) });
        return this.loginFailed(res, "state_mismatch");
      }
      const code = queryString(req.query.code);
      if (!code || code.length > 200) return this.loginFailed(res, "oauth_failed");
      let next = "/";
      try {
        next = sanitizeNext(Buffer.from(stored.slice(dot + 1), "base64url").toString("utf8"), this.baseUrl);
      } catch {
        next = "/";
      }
      try {
        const profile = await fetchGithubProfile(github, code);
        const user = await this.upsertUser({
          githubId: profile.githubId,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        });
        await this.startSession(res, user.id);
        logger.info("dashboard.login", { userId: user.id, provider: "github" });
        res.redirect(302, next);
      } catch (err) {
        const e = toMotionError(err);
        logger.warn("dashboard.oauth_failed", { code: e.code, message: e.message });
        this.loginFailed(res, "oauth_failed");
      }
    });

    router.post("/email/request", express.json({ limit: "16kb" }), async (req, res) => {
      const parsed = EmailRequestBody.safeParse(req.body);
      if (!parsed.success) {
        sendApiError(res, new MotionError("VALIDATION", "A valid email address is required"));
        return;
      }
      // Always 204: the response never reveals whether the address has an account or was rate limited.
      res.status(204).end();
      const email = parsed.data.email.trim().toLowerCase();
      const { config } = this.rt;
      if (!config.RESEND_API_KEY || !config.EMAIL_FROM) return;
      const ipAllowed = this.emailPerIp.allow(clientIp(req));
      const addressAllowed = this.emailPerAddress.allow(email);
      if (!ipAllowed || !addressAllowed) {
        logger.warn("dashboard.email_rate_limited", { byIp: !ipAllowed, byAddress: !addressAllowed });
        return;
      }
      const token = newToken();
      try {
        await this.rt.repos.loginTokens.create({
          email,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString(),
          next: sanitizeNext(parsed.data.next, this.baseUrl),
        });
        await sendMagicLinkEmail({
          apiKey: config.RESEND_API_KEY,
          from: config.EMAIL_FROM,
          to: email,
          link: `${this.baseUrl}/api/auth/email/verify?token=${encodeURIComponent(token)}`,
          fetch: this.fetchImpl,
        });
      } catch (err) {
        const e = toMotionError(err);
        logger.warn("dashboard.email_send_failed", { code: e.code, message: e.message });
      }
    });

    router.get("/email/verify", async (req, res) => {
      res.set("Cache-Control", "no-store");
      const token = queryString(req.query.token);
      if (!token || token.length > MAX_TOKEN_LENGTH) return this.loginFailed(res, "link_invalid");
      try {
        const record = await this.rt.repos.loginTokens.consume(sha256Hex(token));
        if (!record) return this.loginFailed(res, "link_invalid");
        const user = await this.upsertUser({
          email: record.email,
          name: record.email.split("@")[0] || "user",
        });
        await this.startSession(res, user.id);
        logger.info("dashboard.login", { userId: user.id, provider: "email" });
        res.redirect(302, sanitizeNext(record.next, this.baseUrl));
      } catch (err) {
        const e = toMotionError(err);
        logger.warn("dashboard.email_verify_failed", { code: e.code, message: e.message });
        this.loginFailed(res, "link_invalid");
      }
    });

    router.post("/logout", async (req, res) => {
      try {
        await this.endSession(req, res);
        res.status(204).end();
      } catch (err) {
        sendApiError(res, err, logger);
      }
    });

    return router;
  }
}
