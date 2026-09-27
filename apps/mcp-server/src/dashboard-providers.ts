import type { Workspace } from "@motion-mcp/database";
import { multixEnvKeys } from "@motion-mcp/media";
import type { AuthEvent, AuthPrompt, ModelRuntime } from "@motion-mcp/pi-runtime";
import type { PipelineRuntime } from "@motion-mcp/pipeline";
import { MotionError, newId, redact } from "@motion-mcp/shared";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { DashboardIdentity } from "./dashboard-auth.ts";
import { bodyObject } from "./dashboard-http.ts";

type Authed = (fn: (req: Request, res: Response, id: DashboardIdentity) => Promise<void>) => RequestHandler;

const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_EVENTS = 20;
const ProviderId = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);

const LoginBody = z.object({ provider: ProviderId, type: z.enum(["oauth", "api_key"]) });
const RespondBody = z.object({ promptId: z.string().min(1).max(64), value: z.string().max(8192) });
const ModelBody = z.union([
  z.object({ provider: ProviderId, model: z.string().min(1).max(200) }),
  z.object({ provider: z.null() }),
]);
const MultixBody = z.object({ value: z.string().trim().min(1).max(4096) });

/** A pi prompt as the dashboard renders it; the answer goes back with the same `id`. */
interface PublicPrompt {
  id: string;
  type: AuthPrompt["type"];
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

type LoginStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

interface LoginSession {
  id: string;
  workspaceId: string;
  provider: string;
  type: "oauth" | "api_key";
  status: LoginStatus;
  events: AuthEvent[];
  prompt?: PublicPrompt;
  answer?: { resolve(value: string): void; reject(err: Error): void };
  error?: string;
  controller: AbortController;
  expiresAt: number;
}

const publicLogin = (s: LoginSession) => ({
  id: s.id,
  provider: s.provider,
  type: s.type,
  status: s.status,
  events: s.events,
  prompt: s.prompt ?? null,
  error: s.error ?? null,
});

/**
 * Pi logins relayed to the dashboard: pi's prompts and events are held here and polled by the browser,
 * and the browser's answers resolve pi's pending prompt. Answers are never logged or echoed back.
 */
export class PiLogins {
  private readonly sessions = new Map<string, LoginSession>();

  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.finish(s, "cancelled", undefined, id);
  }

  private finish(s: LoginSession, status: LoginStatus, error?: string, deleteId?: string): void {
    if (s.status === "running" || s.status === "waiting") {
      s.status = status;
      s.error = error;
      s.prompt = undefined;
      s.answer?.reject(new Error("Login closed"));
      s.answer = undefined;
      s.controller.abort();
    }
    if (deleteId) this.sessions.delete(deleteId);
  }

  get(id: string, workspaceId: string): LoginSession {
    this.prune();
    const s = this.sessions.get(id);
    if (!s || s.workspaceId !== workspaceId) throw new MotionError("NOT_FOUND", "Login not found");
    return s;
  }

  start(
    runtime: Pick<ModelRuntime, "login">,
    workspaceId: string,
    provider: string,
    type: "oauth" | "api_key",
  ): LoginSession {
    this.prune();
    for (const s of this.sessions.values()) {
      const active = s.status === "running" || s.status === "waiting";
      if (!active) continue;
      // One login per workspace at a time; a new one replaces the old.
      if (s.workspaceId === workspaceId) this.finish(s, "cancelled");
      // OAuth callbacks listen on a fixed local port per provider, so only one such login runs per server.
      else if (type === "oauth" && s.type === "oauth" && s.provider === provider) {
        throw new MotionError(
          "CONFLICT",
          "Another sign-in with this provider is in progress; try again shortly",
        );
      }
    }
    const session: LoginSession = {
      id: newId("login"),
      workspaceId,
      provider,
      type,
      status: "running",
      events: [],
      controller: new AbortController(),
      expiresAt: Date.now() + LOGIN_TTL_MS,
    };
    this.sessions.set(session.id, session);

    const interaction = {
      signal: session.controller.signal,
      notify: (event: AuthEvent) => {
        session.events.push(event);
        if (session.events.length > MAX_EVENTS) session.events.shift();
      },
      prompt: (p: AuthPrompt) =>
        new Promise<string>((resolve, reject) => {
          if (session.controller.signal.aborted) {
            reject(new Error("Login closed"));
            return;
          }
          const promptId = newId("prompt");
          session.prompt = {
            id: promptId,
            type: p.type,
            message: p.message,
            ...("placeholder" in p && p.placeholder ? { placeholder: p.placeholder } : {}),
            ...(p.type === "select" ? { options: p.options.map((o) => ({ ...o })) } : {}),
          };
          session.status = "waiting";
          const clear = () => {
            if (session.prompt?.id !== promptId) return;
            session.prompt = undefined;
            session.answer = undefined;
            if (session.status === "waiting") session.status = "running";
          };
          session.answer = {
            resolve: (value) => {
              clear();
              resolve(value);
            },
            reject: (err) => {
              clear();
              reject(err);
            },
          };
          // Pi withdraws a prompt when another path wins (e.g. the OAuth callback beat a pasted code).
          p.signal?.addEventListener("abort", () => session.answer?.reject(new Error("Prompt withdrawn")), {
            once: true,
          });
        }),
    };

    runtime.login(provider, type, interaction).then(
      () => {
        if (session.status === "running" || session.status === "waiting") {
          session.status = "succeeded";
          session.prompt = undefined;
        }
      },
      (err: unknown) => {
        if (session.status !== "running" && session.status !== "waiting") return;
        const message = err instanceof Error ? err.message : String(err);
        this.finish(session, "failed", redact(message).slice(0, 300));
      },
    );
    return session;
  }

  respond(s: LoginSession, promptId: string, value: string): void {
    if (!s.prompt || s.prompt.id !== promptId || !s.answer) {
      throw new MotionError("CONFLICT", "That prompt is no longer waiting for an answer");
    }
    if (s.prompt.type === "select" && !s.prompt.options?.some((o) => o.id === value)) {
      throw new MotionError("VALIDATION", "Choose one of the listed options");
    }
    s.answer.resolve(value);
  }

  cancel(s: LoginSession): void {
    this.finish(s, "cancelled");
  }
}

/** `/api/providers`: a workspace's pi sign-ins, its pi model choice, and its multix keys. */
export function providerRoutes(rt: PipelineRuntime, authed: Authed): Router {
  const { repos, providers, logger } = rt;
  const logins = new PiLogins();
  const router = express.Router();

  const requireEnabled = () => {
    if (!providers.enabled) {
      throw new MotionError("PROVIDER", "Provider keys are not enabled on this server");
    }
  };

  /** Pi providers a workspace can connect: those with OAuth or an interactive API-key setup. */
  const connectable = (runtime: ModelRuntime) =>
    runtime.getProviders().filter((p) => p.auth.oauth || p.auth.apiKey?.login);

  const findProvider = (runtime: ModelRuntime, providerId: string) => {
    const provider = connectable(runtime).find((p) => p.id === providerId);
    if (!provider) throw new MotionError("NOT_FOUND", "Unknown provider");
    return provider;
  };

  const overview = async (workspace: Workspace) => {
    const multixRecords = providers.enabled
      ? await repos.providerCredentials.list(workspace.id, "multix")
      : [];
    const multix = {
      keys: multixEnvKeys().map(({ name, providers: used }) => {
        const record = multixRecords.find((r) => r.provider === name);
        return {
          name,
          providers: used,
          set: record !== undefined,
          hint: record?.hint ?? null,
          updatedAt: record?.updatedAt ?? null,
        };
      }),
    };
    if (!providers.enabled) {
      return { enabled: false, pi: { providers: [], selected: null, models: {} }, multix };
    }
    const runtime = await providers.piRuntime(workspace.id);
    const piRecords = await repos.providerCredentials.list(workspace.id, "pi");
    const models: Record<string, { id: string; name: string }[]> = {};
    const list = connectable(runtime).map((p) => {
      const record = piRecords.find((r) => r.provider === p.id);
      if (record) models[p.id] = runtime.getModels(p.id).map((m) => ({ id: m.id, name: m.name }));
      return {
        id: p.id,
        name: p.name,
        apiKey: p.auth.apiKey?.login ? { name: p.auth.apiKey.name } : null,
        oauth: p.auth.oauth
          ? {
              name: p.auth.oauth.name,
              loginLabel: p.auth.oauth.loginLabel ?? null,
              isSubscription: p.auth.oauth.isSubscription ?? false,
            }
          : null,
        connected: record
          ? { authType: record.authType, hint: record.hint ?? null, updatedAt: record.updatedAt }
          : null,
      };
    });
    const selected = workspace.piModel && models[workspace.piModel.provider] ? workspace.piModel : null;
    return { enabled: true, pi: { providers: list, selected, models }, multix };
  };

  router.get(
    "/",
    authed(async (_req, res, { workspace }) => {
      res.json(await overview(workspace));
    }),
  );

  // --- pi sign-in ---------------------------------------------------------------------------------

  router.post(
    "/pi/logins",
    authed(async (req, res, { workspace, user }) => {
      requireEnabled();
      const { provider, type } = LoginBody.parse(bodyObject(req));
      const runtime = await providers.piRuntime(workspace.id);
      const p = findProvider(runtime, provider);
      if (type === "oauth" ? !p.auth.oauth : !p.auth.apiKey?.login) {
        throw new MotionError("VALIDATION", `${p.name} does not support this sign-in method`);
      }
      const session = logins.start(runtime, workspace.id, provider, type);
      logger.info("providers.login_started", { userId: user.id, workspaceId: workspace.id, provider, type });
      res.status(201).json({ login: publicLogin(session) });
    }),
  );

  router.get(
    "/pi/logins/:id",
    authed(async (req, res, { workspace }) => {
      res.json({ login: publicLogin(logins.get(String(req.params.id), workspace.id)) });
    }),
  );

  router.post(
    "/pi/logins/:id/respond",
    authed(async (req, res, { workspace }) => {
      const session = logins.get(String(req.params.id), workspace.id);
      const { promptId, value } = RespondBody.parse(bodyObject(req));
      logins.respond(session, promptId, value);
      res.json({ login: publicLogin(session) });
    }),
  );

  router.delete(
    "/pi/logins/:id",
    authed(async (req, res, { workspace }) => {
      logins.cancel(logins.get(String(req.params.id), workspace.id));
      res.status(204).end();
    }),
  );

  router.put(
    "/pi/model",
    authed(async (req, res, { workspace, user }) => {
      requireEnabled();
      const body = ModelBody.parse(bodyObject(req));
      if (body.provider === null) {
        await repos.workspaces.update(workspace.id, { piModel: undefined });
        res.json({ selected: null });
        return;
      }
      if (!(await repos.providerCredentials.get(workspace.id, "pi", body.provider))) {
        throw new MotionError("VALIDATION", "Connect this provider before choosing its model");
      }
      const runtime = await providers.piRuntime(workspace.id);
      if (!runtime.getModel(body.provider, body.model)) throw new MotionError("VALIDATION", "Unknown model");
      const piModel = { provider: body.provider, model: body.model };
      await repos.workspaces.update(workspace.id, { piModel });
      logger.info("providers.model_selected", { userId: user.id, workspaceId: workspace.id, ...piModel });
      res.json({ selected: piModel });
    }),
  );

  router.delete(
    "/pi/:provider",
    authed(async (req, res, { workspace, user }) => {
      requireEnabled();
      const provider = ProviderId.parse(req.params.provider);
      if (!(await repos.providerCredentials.get(workspace.id, "pi", provider))) {
        throw new MotionError("NOT_FOUND", "Provider is not connected");
      }
      const runtime = await providers.piRuntime(workspace.id);
      await runtime.logout(provider);
      if (workspace.piModel?.provider === provider) {
        await repos.workspaces.update(workspace.id, { piModel: undefined });
      }
      logger.info("providers.disconnected", { userId: user.id, workspaceId: workspace.id, provider });
      res.status(204).end();
    }),
  );

  // --- multix keys --------------------------------------------------------------------------------

  const multixName = (value: unknown): string => {
    const name = String(value);
    if (!multixEnvKeys().some((k) => k.name === name)) throw new MotionError("NOT_FOUND", "Unknown key");
    return name;
  };

  router.put(
    "/multix/:name",
    authed(async (req, res, { workspace, user }) => {
      requireEnabled();
      const name = multixName(req.params.name);
      const { value } = MultixBody.parse(bodyObject(req));
      const record = await providers.setMultixKey(workspace.id, name, value);
      logger.info("providers.multix_key_set", { userId: user.id, workspaceId: workspace.id, name });
      res.json({ key: { name, set: true, hint: record.hint ?? null, updatedAt: record.updatedAt } });
    }),
  );

  router.delete(
    "/multix/:name",
    authed(async (req, res, { workspace, user }) => {
      requireEnabled();
      const name = multixName(req.params.name);
      if (!(await repos.providerCredentials.delete(workspace.id, "multix", name))) {
        throw new MotionError("NOT_FOUND", "Key is not set");
      }
      logger.info("providers.multix_key_removed", { userId: user.id, workspaceId: workspace.id, name });
      res.status(204).end();
    }),
  );

  return router;
}
