import { createRuntime } from "@motion-mcp/pipeline";
import { createLogger, loadConfig, loadDotEnv, registerSecretsFromEnv } from "@motion-mcp/shared";
import { anonymousWorkspaceFor, doctorSummary, startServer } from "./server.ts";

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  loadDotEnv();
  registerSecretsFromEnv();
  const config = loadConfig();
  const logger = createLogger({ service: "motion-mcp" });
  const rt = await createRuntime(config, { logger });

  if (anonymousWorkspaceFor(config)) {
    logger.warn("auth.anonymous", {
      detail: "NODE_ENV=development and MOTION_API_KEYS is empty: unauthenticated MCP calls are accepted",
    });
  }

  const server = await startServer(rt, { port: config.PORT });
  logger.info("server.listening", {
    port: config.PORT,
    mcp: `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/mcp`,
  });
  void doctorSummary(rt).then(
    (summary) => logger.info("server.doctor", summary),
    (err: unknown) => logger.warn("server.doctor_failed", { message: String(err) }),
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("server.shutdown", { signal });
    server.close();
    server.closeIdleConnections();
    rt.close(SHUTDOWN_GRACE_MS)
      .catch((err: unknown) => logger.error("server.shutdown_failed", { message: String(err) }))
      .finally(() => {
        server.closeAllConnections();
        process.exit(0);
      });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  const logger = createLogger({ service: "motion-mcp" });
  logger.error("server.start_failed", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
