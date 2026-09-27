import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CreditLedger, JsonlLedgerStore, type LedgerStore } from "@motion-mcp/billing";
import { FileRepository, type Repositories } from "@motion-mcp/database";
import { Director } from "@motion-mcp/director";
import { type DomainPack, loadDomainPack } from "@motion-mcp/domain-pack";
import { createHyperframesAdapter, type MotionRendererAdapter } from "@motion-mcp/hyperframes-adapter";
import { createDecisionClient, type DecisionClient } from "@motion-mcp/jev-router";
import { type ModelGateway, OpenRouterClient } from "@motion-mcp/llm";
import { MultixRunner } from "@motion-mcp/media";
import { PiWorker, type SceneWorker } from "@motion-mcp/pi-runtime";
import { createLogger, type Logger, type MotionConfig, registerSecret, SealedBox } from "@motion-mcp/shared";
import { type ArtifactStore, createArtifactStore } from "@motion-mcp/storage";
import { ArtifactSigner, type ArtifactUrlFn, artifactUrlFn, resolveSigningSecret } from "./artifact-urls.ts";
import { JobQueue } from "./job-queue.ts";
import { createVisionQaSource, type QaSource } from "./qa.ts";
import { type MediaRuntime, serverMediaEnv } from "./scene-assets.ts";
import { WorkspaceProviders } from "./workspace-providers.ts";

/** Everything the pipeline needs, built once per process by `createRuntime`. */
export interface PipelineRuntime {
  config: MotionConfig;
  logger: Logger;
  dataDir: string;
  /** Per-version working directories (compiled HyperFrames projects, local renders). */
  workDir: string;
  repos: Repositories;
  store: ArtifactStore;
  signer: ArtifactSigner;
  artifactUrl: ArtifactUrlFn;
  ledger: CreditLedger;
  domainPack: DomainPack;
  /** OpenRouter gateway; absent without OPENROUTER_API_KEY (host-opus still works). */
  gateway?: ModelGateway;
  director: Director;
  decisions: DecisionClient;
  renderer: MotionRendererAdapter;
  /** Pi scene worker; absent without OPENROUTER_API_KEY. */
  sceneWorker?: SceneWorker;
  /** Workspace-owned pi sign-ins and multix keys; resolves each job's scene worker. */
  providers: WorkspaceProviders;
  /** multix for scene images; absent when the CLI is missing or ASSET_IMAGES_PER_JOB is 0. */
  media?: MediaRuntime;
  /** Extra QA passes after lint/check (vision QA when a key is configured). */
  qaSources: QaSource[];
  queue: JobQueue;
  close(graceMs?: number): Promise<void>;
}

/** Test and embedding seams: any dependency may be replaced; the rest are built from config. */
export interface RuntimeOverrides {
  logger?: Logger;
  repos?: Repositories;
  store?: ArtifactStore;
  ledgerStore?: LedgerStore;
  domainPack?: DomainPack;
  gateway?: ModelGateway | null;
  decisions?: DecisionClient;
  renderer?: MotionRendererAdapter;
  sceneWorker?: SceneWorker | null;
  media?: MediaRuntime | null;
  qaSources?: QaSource[];
}

function createMedia(config: MotionConfig, logger: Logger): MediaRuntime | undefined {
  if (config.ASSET_IMAGES_PER_JOB === 0) return undefined;
  try {
    return { runner: new MultixRunner({ multixBin: config.MULTIX_BIN }), serverEnv: serverMediaEnv() };
  } catch (err) {
    logger.warn("multix.unavailable", { message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

export async function createRuntime(
  config: MotionConfig,
  overrides: RuntimeOverrides = {},
): Promise<PipelineRuntime> {
  const logger = overrides.logger ?? createLogger({ service: "motion-mcp" });
  const dataDir = resolve(config.DATA_DIR);
  const workDir = join(dataDir, "work");
  await mkdir(workDir, { recursive: true });
  for (const secret of [
    config.OPENROUTER_API_KEY,
    config.TYPESAFE_API_KEY,
    config.R2_SECRET_ACCESS_KEY,
    config.POLAR_WEBHOOK_SECRET,
    config.POLAR_ACCESS_TOKEN,
    config.ARTIFACT_SIGNING_SECRET,
    config.CREDENTIALS_ENCRYPTION_KEY,
    ...Object.values(serverMediaEnv()),
  ]) {
    registerSecret(secret);
  }

  const repos = overrides.repos ?? FileRepository.fromDataDir(dataDir);
  const store = overrides.store ?? createArtifactStore({ ...config, DATA_DIR: dataDir });
  const signer = new ArtifactSigner(resolveSigningSecret(config, logger), config.PUBLIC_BASE_URL);
  const ledger = new CreditLedger(
    overrides.ledgerStore ?? new JsonlLedgerStore(join(dataDir, "ledger", "credits.jsonl")),
  );
  const domainPack = overrides.domainPack ?? (await loadDomainPack());

  const gateway =
    overrides.gateway === null
      ? undefined
      : (overrides.gateway ??
        (config.OPENROUTER_API_KEY
          ? new OpenRouterClient({
              apiKey: config.OPENROUTER_API_KEY,
              baseUrl: config.OPENROUTER_BASE_URL,
              appName: "motion-mcp",
            })
          : undefined));
  const director = new Director({ gateway, directorModel: config.DIRECTOR_MODEL });
  const decisions = overrides.decisions ?? createDecisionClient(config, { gateway });

  let sceneWorker: SceneWorker | undefined;
  if (overrides.sceneWorker !== undefined) sceneWorker = overrides.sceneWorker ?? undefined;
  else if (config.OPENROUTER_API_KEY && config.IMPLEMENTATION_MODE !== "deterministic") {
    try {
      sceneWorker = await PiWorker.fromConfig(config);
    } catch (err) {
      logger.warn("pi.unavailable", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  const providers = new WorkspaceProviders({
    repos,
    box: config.CREDENTIALS_ENCRYPTION_KEY ? new SealedBox(config.CREDENTIALS_ENCRYPTION_KEY) : undefined,
    logger,
    defaultWorker: sceneWorker,
    workersAllowed: config.IMPLEMENTATION_MODE !== "deterministic",
  });

  const qaSources =
    overrides.qaSources ??
    (gateway && config.OPENROUTER_API_KEY && config.VISION_MODEL
      ? [createVisionQaSource({ gateway, model: config.VISION_MODEL, logger })]
      : []);

  const queue = new JobQueue(config.JOB_CONCURRENCY, (jobId, err) =>
    logger.error("job.unhandled", { jobId, message: err instanceof Error ? err.message : String(err) }),
  );

  return {
    config,
    logger,
    dataDir,
    workDir,
    repos,
    store,
    signer,
    artifactUrl: artifactUrlFn(store, signer),
    ledger,
    domainPack,
    gateway,
    director,
    decisions,
    renderer: overrides.renderer ?? createHyperframesAdapter(),
    sceneWorker,
    providers,
    media: overrides.media === null ? undefined : (overrides.media ?? createMedia(config, logger)),
    qaSources,
    queue,
    close: (graceMs) => queue.close(graceMs),
  };
}
