import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { hashApiKey, isApiKeyFormat, type Repositories } from "@motion-mcp/database";
import { createMotionService, type PipelineRuntime, recoverInterruptedJobs } from "@motion-mcp/pipeline";
import type { MotionConfig } from "@motion-mcp/shared";
import type { Express } from "express";
import { createDashboardApi } from "./dashboard-api.ts";
import { dashboardDistDir, mountDashboardStatic } from "./dashboard-static.ts";
import { type ApiKeyVerifier, chainVerifiers, createHttpApp, staticKeyVerifier } from "./http-app.ts";
import { mountPublicRoutes } from "./public-routes.ts";

/** Workspace keys issued by `pnpm motion keys create`, looked up by hash. */
export function repositoryKeyVerifier(repos: Repositories): ApiKeyVerifier {
  return async (token) => {
    if (!isApiKeyFormat(token)) return null;
    const key = await repos.apiKeys.findActiveByHash(hashApiKey(token));
    return key ? { workspaceId: key.workspaceId, keyId: key.id } : null;
  };
}

export function staticApiKeys(config: MotionConfig): string[] {
  return config.MOTION_API_KEYS.split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Unauthenticated access is a development convenience only: never in production or test, and never when
 * any static key is configured.
 */
export function anonymousWorkspaceFor(config: MotionConfig): string | undefined {
  return config.NODE_ENV === "development" && staticApiKeys(config).length === 0 ? "ws_default" : undefined;
}

export function allowedHostnames(config: MotionConfig): string[] {
  const hosts = new Set(
    config.ALLOWED_HOSTS.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  hosts.add(new URL(config.PUBLIC_BASE_URL).hostname.toLowerCase());
  return [...hosts];
}

export interface BuildAppOptions {
  /** Outbound HTTP client for the dashboard (GitHub, Resend, Polar); injectable for tests. */
  fetch?: typeof fetch;
}

/** The complete HTTP app (MCP, dashboard API and SPA, artifacts, published videos, webhook) over a runtime. */
export function buildApp(rt: PipelineRuntime, options: BuildAppOptions = {}): Express {
  const { config } = rt;
  const service = createMotionService(rt);
  return createHttpApp({
    service,
    verifyKey: chainVerifiers(staticKeyVerifier(staticApiKeys(config)), repositoryKeyVerifier(rt.repos)),
    allowedHosts: allowedHostnames(config),
    logger: rt.logger,
    anonymousWorkspaceId: anonymousWorkspaceFor(config),
    mount: (app) => {
      mountPublicRoutes(app, rt);
      app.use("/api", createDashboardApi({ rt, service, fetch: options.fetch }));
      mountDashboardStatic(app, config);
    },
  });
}

/** Recover jobs a previous process left behind, then listen. */
export async function startServer(
  rt: PipelineRuntime,
  options: { port: number; host?: string },
): Promise<Server> {
  await recoverInterruptedJobs(rt);
  const app = buildApp(rt);
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(options.port, options.host ?? "0.0.0.0", (err?: Error) => {
      if (err) reject(err);
      else resolve(server);
    });
  });
}

/** One-line readiness facts for the startup log: never secret values, only whether they are set. */
export async function doctorSummary(rt: PipelineRuntime): Promise<Record<string, unknown>> {
  const { config } = rt;
  const report = await rt.renderer.doctor({ ensureBrowser: false }).catch(() => undefined);
  return {
    render: report
      ? {
          ok: report.ok,
          node: report.node.detail,
          hyperframes: report.hyperframes.ok ? report.hyperframes.version : report.hyperframes.detail,
          chrome: report.chrome.ok ? "found" : report.chrome.detail,
          ffmpeg: report.ffmpeg.ok ? "found" : report.ffmpeg.detail,
        }
      : { ok: false, detail: "doctor failed" },
    storage: rt.store.driver,
    directorModes: rt.gateway ? ["host-opus", "internal-opus"] : ["host-opus"],
    defaultDirectorMode: config.DEFAULT_DIRECTOR_MODE,
    sceneWorker: rt.sceneWorker ? config.IMPLEMENTATION_MODE : "deterministic",
    visionQa: rt.qaSources.length > 0,
    staticApiKeys: staticApiKeys(config).length,
    anonymousAccess: anonymousWorkspaceFor(config) !== undefined,
    polarWebhook: Boolean(config.POLAR_WEBHOOK_SECRET),
    dashboard: {
      built: existsSync(join(dashboardDistDir(config), "index.html")),
      github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
      email: Boolean(config.RESEND_API_KEY && config.EMAIL_FROM),
      checkout: Boolean(config.POLAR_ACCESS_TOKEN && config.POLAR_PRODUCT_ID),
    },
    artifactSigningSecret: config.ARTIFACT_SIGNING_SECRET ? "explicit" : "derived",
    jobConcurrency: config.JOB_CONCURRENCY,
  };
}
