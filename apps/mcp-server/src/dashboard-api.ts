import {
  CREDIT_PRICES,
  CREDIT_USD,
  createPolarCheckout,
  type LedgerTransaction,
  accounts as ledgerAccounts,
} from "@motion-mcp/billing";
import {
  type ApiKey,
  DirectorMode,
  generateApiKey,
  type Project,
  type Recipe,
  RecipeFormat,
  type TraceRecord,
  type UsageEvent,
} from "@motion-mcp/database";
import {
  CreateInput,
  GetProjectInput,
  InspectInput,
  ListProjectsInput,
  type ListProjectsOutput,
  type MotionService,
  type PipelineRuntime,
  PublishInput,
  RenderInput,
  SearchInput,
} from "@motion-mcp/pipeline";
import { MotionError, newId, toMotionError } from "@motion-mcp/shared";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { DashboardAuth, type DashboardIdentity } from "./dashboard-auth.ts";
import { sendApiError } from "./dashboard-http.ts";

export interface DashboardApiOptions {
  rt: PipelineRuntime;
  service: MotionService;
  /** HTTP client for GitHub, Resend and Polar; injectable for tests. */
  fetch?: typeof fetch;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_ACTIVE_KEYS = 25;
const MAX_RECIPES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROJECT_INCLUDE = ["versions", "renders", "usage", "trace"] as const;

type Handler = (req: Request, res: Response, id: DashboardIdentity) => Promise<void>;

/** Parses `a,b,c` query values into a de-duplicated list, or undefined when absent. */
function csv(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return [
    ...new Set(
      value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new MotionError("VALIDATION", "Expected an integer query parameter");
  return n;
}

function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new MotionError("VALIDATION", "Expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

const IsoTime = z.iso.datetime({ offset: true });

const KeyCreateBody = z.object({ name: z.string().trim().min(1).max(120) });

const RecipeBody = z.object({
  name: z.string().trim().min(1).max(120),
  brief: z.string().min(3).max(8000),
  directorMode: DirectorMode.optional(),
  format: RecipeFormat.optional(),
  durationSeconds: z.number().min(3).max(180).optional(),
  quality: z.enum(["preview", "final"]).optional(),
  notes: z.string().max(4000).optional(),
});

/** PATCH body: every field optional; `null` clears an optional field. */
const RecipePatchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  brief: z.string().min(3).max(8000).optional(),
  directorMode: DirectorMode.nullish(),
  format: RecipeFormat.nullish(),
  durationSeconds: z.number().min(3).max(180).nullish(),
  quality: z.enum(["preview", "final"]).nullish(),
  notes: z.string().max(4000).nullish(),
});

const publicKey = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt,
  revokedAt: k.revokedAt,
});

const publicUsage = (e: UsageEvent) => ({
  id: e.id,
  projectId: e.projectId,
  jobId: e.jobId,
  operation: e.operation,
  quantity: e.quantity,
  credits: e.credits,
  byok: e.byok,
  createdAt: e.createdAt,
});

const traceSummary = (t: TraceRecord) => ({
  id: t.id,
  name: t.name,
  projectId: t.projectId,
  jobId: t.jobId,
  createdAt: t.createdAt,
  summary: t.summary,
});

/** Adds `createdAt` and `directorMode` to list items (the MCP list output omits them). */
function withProjectFields(items: ListProjectsOutput["projects"], all: Project[]) {
  const byId = new Map(all.map((p) => [p.id, p]));
  return items.map((item) => {
    const p = byId.get(item.id);
    return p ? { ...item, createdAt: p.createdAt, directorMode: p.directorMode } : item;
  });
}

/** A ledger transaction as seen by the workspace: net change to its available and held credits. */
function ledgerView(workspaceId: string, tx: LedgerTransaction) {
  const available = ledgerAccounts.available(workspaceId);
  const held = ledgerAccounts.held(workspaceId);
  let availableDelta = 0;
  let heldDelta = 0;
  for (const e of tx.entries) {
    if (e.account === available) availableDelta += e.amount;
    else if (e.account === held) heldDelta += e.amount;
  }
  return {
    id: tx.id,
    kind: tx.kind,
    operation: tx.operation,
    reservationId: tx.reservationId,
    availableDelta,
    heldDelta,
    metadata: tx.metadata,
    createdAt: tx.createdAt,
  };
}

/**
 * The dashboard's JSON API under `/api`: cookie-session auth, Origin-checked mutations, and thin wrappers
 * over MotionService (the same service /mcp uses) plus keys, usage, billing and recipes.
 */
export function createDashboardApi(opts: DashboardApiOptions): Router {
  const { rt, service } = opts;
  const { repos, ledger, config, logger } = rt;
  const fetchImpl = opts.fetch ?? fetch;
  const auth = new DashboardAuth(rt, fetchImpl);
  const baseUrl = config.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const expectedOrigin = new URL(config.PUBLIC_BASE_URL).origin;

  /** Same-origin only; in development a local Vite dev server origin is also accepted. */
  const originAllowed = (origin: string | undefined): boolean => {
    if (!origin) return false;
    if (origin === expectedOrigin) return true;
    if (config.NODE_ENV !== "development") return false;
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    } catch {
      return false;
    }
  };

  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method) || originAllowed(req.headers.origin)) {
      next();
      return;
    }
    res.status(403).json({ error: "forbidden", message: "Cross-origin request rejected" });
  });

  router.use("/auth", auth.routes());
  router.use(express.json({ limit: "1mb" }));

  const authed =
    (fn: Handler) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        const identity = await auth.resolve(req, res);
        if (!identity) {
          res.status(401).json({ error: "unauthorized", message: "Sign in required" });
          return;
        }
        await fn(req, res, identity);
      } catch (err) {
        sendApiError(res, err, logger);
      }
    };

  const balanceOf = async (workspaceId: string) => {
    const b = await ledger.balance(workspaceId);
    return { balance: b.available, held: b.held };
  };

  /** Ownership checks return not_found for other workspaces' records, never forbidden. */
  const ownedRecipe = async (id: string, workspaceId: string): Promise<Recipe> => {
    const recipe = await repos.recipes.get(id).catch(() => undefined);
    if (!recipe || recipe.workspaceId !== workspaceId) throw new MotionError("NOT_FOUND", "Recipe not found");
    return recipe;
  };

  const ownedProjectId = async (id: string, workspaceId: string): Promise<string> => {
    const project = await repos.projects.get(id).catch(() => undefined);
    if (!project || project.workspaceId !== workspaceId) {
      throw new MotionError("NOT_FOUND", "Project not found");
    }
    return project.id;
  };

  // --- account ------------------------------------------------------------------------------------

  router.get(
    "/me",
    authed(async (_req, res, { user, workspace }) => {
      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          createdAt: user.createdAt,
        },
        workspace: { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt },
        credits: await balanceOf(workspace.id),
      });
    }),
  );

  router.get(
    "/overview",
    authed(async (_req, res, { workspace, caller }) => {
      const until = new Date();
      const since = new Date(until.getTime() - 30 * DAY_MS);
      const [credits, recent, all, events] = await Promise.all([
        balanceOf(workspace.id),
        service.listProjects(caller, ListProjectsInput.parse({ limit: 5 })),
        repos.projects.list({ workspaceId: workspace.id }),
        repos.usage.list({ workspaceId: workspace.id, since: since.toISOString() }),
      ]);
      const byOperation = new Map<string, { operation: string; quantity: number; credits: number }>();
      for (const e of events) {
        const row = byOperation.get(e.operation) ?? { operation: e.operation, quantity: 0, credits: 0 };
        row.quantity += e.quantity;
        row.credits += e.credits;
        byOperation.set(e.operation, row);
      }
      res.json({
        credits,
        trialCredits: config.TRIAL_CREDITS,
        projectCount: all.length,
        recentProjects: withProjectFields(recent.projects, all),
        usage: {
          since: since.toISOString(),
          until: until.toISOString(),
          credits: events.reduce((s, e) => s + e.credits, 0),
          events: events.length,
          byOperation: [...byOperation.values()].sort((a, b) => b.credits - a.credits),
        },
      });
    }),
  );

  // --- projects (wrapping MotionService) ----------------------------------------------------------

  router.get(
    "/projects",
    authed(async (req, res, { caller, workspace }) => {
      const input = ListProjectsInput.parse({
        limit: optionalInt(req.query.limit),
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        status: typeof req.query.status === "string" ? req.query.status : undefined,
      });
      const page = await service.listProjects(caller, input);
      const all = await repos.projects.list({ workspaceId: workspace.id });
      res.json({ ...page, projects: withProjectFields(page.projects, all) });
    }),
  );

  router.get(
    "/projects/:id",
    authed(async (req, res, { caller }) => {
      const input = GetProjectInput.parse({
        projectId: req.params.id,
        include: csv(req.query.include) ?? [...DEFAULT_PROJECT_INCLUDE],
      });
      const view = await service.getProject(caller, input);
      // QA findings for the current version come from the same inspect call /mcp exposes.
      let qaIssues: unknown[] = [];
      if (view.project.currentVersion >= 1) {
        const inspected = await service
          .inspect(caller, InspectInput.parse({ target: "project", projectId: view.project.id }))
          .catch((err: unknown) => {
            logger.warn("dashboard.qa_issues_failed", { message: toMotionError(err).message });
            return undefined;
          });
        if (Array.isArray(inspected?.issues)) qaIssues = inspected.issues;
      }
      res.json({ ...view, qaIssues });
    }),
  );

  router.post(
    "/projects",
    authed(async (req, res, { caller }) => {
      const body = bodyObject(req);
      // The dashboard has no host model, so the server's own director is the default.
      const directorMode =
        body.directorMode ?? (body.creativeSpec === undefined ? "internal-opus" : undefined);
      const input = CreateInput.parse({ ...body, directorMode });
      res.status(202).json(await service.create(caller, input));
    }),
  );

  router.post(
    "/projects/:id/render",
    authed(async (req, res, { caller }) => {
      const input = RenderInput.parse({ ...bodyObject(req), projectId: req.params.id });
      res.status(202).json(await service.render(caller, input));
    }),
  );

  router.post(
    "/renders/:id/publish",
    authed(async (req, res, { caller }) => {
      const input = PublishInput.parse({ ...bodyObject(req), renderId: req.params.id });
      res.json(await service.publish(caller, input));
    }),
  );

  router.get(
    "/projects/:id/traces",
    authed(async (req, res, { workspace }) => {
      const projectId = await ownedProjectId(String(req.params.id), workspace.id);
      const traces = await repos.traces.list({ projectId, limit: 50 });
      res.json({ traces: traces.filter((t) => t.workspaceId === workspace.id).map(traceSummary) });
    }),
  );

  router.get(
    "/traces/:id",
    authed(async (req, res, { workspace }) => {
      const trace = await repos.traces.get(String(req.params.id)).catch(() => undefined);
      if (!trace || trace.workspaceId !== workspace.id) throw new MotionError("NOT_FOUND", "Trace not found");
      // Traces are redacted when they are persisted.
      res.json({ trace: { ...traceSummary(trace), root: trace.root } });
    }),
  );

  router.get(
    "/search",
    authed(async (req, res, { caller }) => {
      const input = SearchInput.parse({
        query: typeof req.query.q === "string" ? req.query.q : "",
        types: csv(req.query.types),
        limit: optionalInt(req.query.limit),
      });
      res.json(await service.search(caller, input));
    }),
  );

  // --- API keys -----------------------------------------------------------------------------------

  router.get(
    "/keys",
    authed(async (_req, res, { workspace }) => {
      res.json({ keys: (await repos.apiKeys.listByWorkspace(workspace.id)).map(publicKey) });
    }),
  );

  router.post(
    "/keys",
    authed(async (req, res, { workspace, user }) => {
      const { name } = KeyCreateBody.parse(bodyObject(req));
      const active = (await repos.apiKeys.listByWorkspace(workspace.id)).filter((k) => !k.revokedAt);
      if (active.length >= MAX_ACTIVE_KEYS) {
        throw new MotionError("CONFLICT", `A workspace can have at most ${MAX_ACTIVE_KEYS} active keys`);
      }
      const generated = generateApiKey();
      const record = await repos.apiKeys.create({
        id: newId("key"),
        workspaceId: workspace.id,
        name,
        hash: generated.hash,
        prefix: generated.prefix,
        createdAt: new Date().toISOString(),
      });
      logger.info("dashboard.key_created", { userId: user.id, workspaceId: workspace.id, keyId: record.id });
      res.status(201).json({ key: publicKey(record), secret: generated.key });
    }),
  );

  router.delete(
    "/keys/:id",
    authed(async (req, res, { workspace, user }) => {
      const key = await repos.apiKeys.get(String(req.params.id)).catch(() => undefined);
      if (!key || key.workspaceId !== workspace.id) throw new MotionError("NOT_FOUND", "Key not found");
      await repos.apiKeys.revoke(key.id);
      logger.info("dashboard.key_revoked", { userId: user.id, workspaceId: workspace.id, keyId: key.id });
      res.status(204).end();
    }),
  );

  // --- usage and billing --------------------------------------------------------------------------

  router.get(
    "/usage",
    authed(async (req, res, { workspace }) => {
      const now = new Date();
      const since =
        IsoTime.optional().parse(req.query.since) ?? new Date(now.getTime() - 30 * DAY_MS).toISOString();
      const until = IsoTime.optional().parse(req.query.until) ?? now.toISOString();
      const sinceMs = Date.parse(since);
      const untilMs = Date.parse(until);
      if (sinceMs >= untilMs) throw new MotionError("VALIDATION", "since must be before until");
      const [events, txs] = await Promise.all([
        repos.usage.list({
          workspaceId: workspace.id,
          since: new Date(sinceMs).toISOString(),
          until: new Date(untilMs).toISOString(),
        }),
        ledger.transactions(workspace.id),
      ]);
      const inRange = txs.filter((t) => {
        const at = Date.parse(t.createdAt);
        return at >= sinceMs && at < untilMs;
      });
      res.json({
        since: new Date(sinceMs).toISOString(),
        until: new Date(untilMs).toISOString(),
        totals: { credits: events.reduce((s, e) => s + e.credits, 0), events: events.length },
        events: events.map(publicUsage),
        ledger: inRange.map((t) => ledgerView(workspace.id, t)),
      });
    }),
  );

  const checkoutEnabled = () => Boolean(config.POLAR_ACCESS_TOKEN && config.POLAR_PRODUCT_ID);

  router.get(
    "/billing",
    authed(async (_req, res, { workspace }) => {
      res.json({
        credits: await balanceOf(workspace.id),
        creditUsd: CREDIT_USD,
        prices: Object.entries(CREDIT_PRICES).map(([operation, p]) => ({
          operation,
          credits: p.credits,
          unit: p.unit,
        })),
        checkout: { enabled: checkoutEnabled() },
      });
    }),
  );

  router.post(
    "/billing/checkout",
    authed(async (_req, res, { workspace, user }) => {
      if (!config.POLAR_ACCESS_TOKEN || !config.POLAR_PRODUCT_ID) {
        res.json({ enabled: false });
        return;
      }
      const checkout = await createPolarCheckout({
        accessToken: config.POLAR_ACCESS_TOKEN,
        environment: config.POLAR_ENVIRONMENT,
        productId: config.POLAR_PRODUCT_ID,
        workspaceId: workspace.id,
        successUrl: `${baseUrl}/billing?checkout=success`,
        customerEmail: user.email,
        fetch: fetchImpl,
      });
      res.json({ enabled: true, url: checkout.url });
    }),
  );

  // --- recipes ------------------------------------------------------------------------------------

  router.get(
    "/recipes",
    authed(async (_req, res, { workspace }) => {
      res.json({ recipes: await repos.recipes.list({ workspaceId: workspace.id }) });
    }),
  );

  router.post(
    "/recipes",
    authed(async (req, res, { workspace }) => {
      const input = RecipeBody.parse(bodyObject(req));
      if ((await repos.recipes.list({ workspaceId: workspace.id })).length >= MAX_RECIPES) {
        throw new MotionError("CONFLICT", `A workspace can have at most ${MAX_RECIPES} recipes`);
      }
      res.status(201).json({ recipe: await repos.recipes.create({ ...input, workspaceId: workspace.id }) });
    }),
  );

  router.get(
    "/recipes/:id",
    authed(async (req, res, { workspace }) => {
      res.json({ recipe: await ownedRecipe(String(req.params.id), workspace.id) });
    }),
  );

  router.patch(
    "/recipes/:id",
    authed(async (req, res, { workspace }) => {
      const recipe = await ownedRecipe(String(req.params.id), workspace.id);
      const parsed = RecipePatchBody.parse(bodyObject(req));
      const patch = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, v === null ? undefined : v]),
      ) as Partial<Omit<Recipe, "id" | "workspaceId" | "createdAt" | "updatedAt">>;
      res.json({ recipe: await repos.recipes.update(recipe.id, patch) });
    }),
  );

  router.delete(
    "/recipes/:id",
    authed(async (req, res, { workspace }) => {
      const recipe = await ownedRecipe(String(req.params.id), workspace.id);
      await repos.recipes.delete(recipe.id);
      res.status(204).end();
    }),
  );

  // Unknown /api paths are JSON 404s, never the SPA shell.
  router.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "Unknown API route" });
  });

  // Body parser failures (malformed JSON, oversized bodies) and anything else thrown outside a handler.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      sendApiError(
        res,
        new MotionError("VALIDATION", status === 413 ? "Request body too large" : "Invalid JSON body"),
      );
      return;
    }
    sendApiError(res, err, logger);
  });

  return router;
}
