import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateApiKey } from "@motion-mcp/database";
import { jsonSchemas } from "@motion-mcp/motion-ir";
import { renderTree, type SpanData } from "@motion-mcp/observability";
import {
  type CallerContext,
  CreateInput,
  createMotionService,
  createRuntime,
  jobResult,
  type PipelineRuntime,
  RenderInput,
} from "@motion-mcp/pipeline";
import {
  createLogger,
  loadConfig,
  loadDotEnv,
  MotionError,
  newId,
  registerSecretsFromEnv,
  toMotionError,
} from "@motion-mcp/shared";
import { doctorSummary } from "./server.ts";

const USAGE = `Usage: pnpm motion <command> [options]

Commands:
  create --brief <text> [--spec <creative-spec.json>] [--mode host-opus|internal-opus]
         [--quality preview|final] [--duration <seconds>] [--out <file.mp4>] [--workspace <id>]
      Run a create job to completion and print its outputs, trace summary and cost.
  render --project <id> [--quality preview|final] [--version <n>] [--out <file.mp4>] [--workspace <id>]
      Render a stored project version to completion.
  doctor
      Check Node, HyperFrames, Chrome, FFmpeg and the configured providers.
  schema
      Print the CreativeSpec and ScenePatch JSON Schemas.
  keys create --name <label> [--workspace <id>]
      Create a workspace API key. The key is printed once and never stored in plaintext.
`;

const DEFAULT_WORKSPACE = "ws_default";

function print(value: unknown): void {
  process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
}

async function bootRuntime(): Promise<PipelineRuntime> {
  loadDotEnv();
  registerSecretsFromEnv();
  const config = loadConfig();
  return createRuntime(config, { logger: createLogger({ service: "motion-cli" }) });
}

function localPathOf(rt: PipelineRuntime, key: string | undefined): Promise<string | undefined> {
  if (!key) return Promise.resolve(undefined);
  return rt.store.url(key).then((url) => (url.startsWith("file:") ? fileURLToPath(url) : url));
}

/** Wait for a job, then print where its outputs are and what it cost. */
async function reportJob(rt: PipelineRuntime, jobId: string, out: string | undefined): Promise<number> {
  await rt.queue.settled(jobId);
  const job = await rt.repos.jobs.get(jobId);
  if (!job) throw new MotionError("NOT_FOUND", `Job ${jobId} disappeared`);
  const result = jobResult(job);
  const renders = [];
  for (const r of result.renders) {
    renders.push({ id: r.id, quality: r.quality, status: r.status, path: await localPathOf(rt, r.key) });
  }
  const trace = job.traceId ? await rt.repos.traces.get(job.traceId) : undefined;
  if (trace) print(renderTree(trace.root as SpanData));

  const best = [...result.renders].reverse().find((r) => r.status === "succeeded" && r.key);
  let copied: string | undefined;
  if (out && best?.key) {
    const from = await localPathOf(rt, best.key);
    if (from && !from.includes("://")) {
      copied = resolve(out);
      await mkdir(dirname(copied), { recursive: true });
      await copyFile(from, copied);
    }
  }
  print({
    projectId: job.projectId,
    jobId: job.id,
    status: job.status,
    version: result.version,
    error: job.error,
    renders,
    contactSheet: await localPathOf(rt, result.contactSheetKey),
    out: copied,
    critiqueRequest: job.status === "awaiting_host" ? result.critiqueRequest?.requestId : undefined,
    warnings: result.warnings,
    credits: { quoted: result.quotedCredits, captured: result.capturedCredits, usage: result.usage },
    costUsd: result.costUsd,
    trace: trace?.summary,
  });
  return job.status === "succeeded" || job.status === "awaiting_host" ? 0 : 1;
}

async function cmdCreate(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      brief: { type: "string" },
      spec: { type: "string" },
      mode: { type: "string" },
      quality: { type: "string", default: "preview" },
      duration: { type: "string" },
      out: { type: "string" },
      workspace: { type: "string", default: DEFAULT_WORKSPACE },
    },
  });
  const creativeSpec = values.spec ? JSON.parse(await readFile(resolve(values.spec), "utf8")) : undefined;
  const input = CreateInput.parse({
    brief: values.brief ?? creativeSpec?.logline ?? creativeSpec?.title,
    creativeSpec,
    directorMode: values.mode ?? (creativeSpec ? "host-opus" : undefined),
    quality: values.quality,
    durationSeconds: values.duration ? Number(values.duration) : undefined,
  });
  const rt = await bootRuntime();
  try {
    const caller: CallerContext = { workspaceId: values.workspace, keyId: "cli" };
    const created = await createMotionService(rt).create(caller, input);
    process.stderr.write(`Project ${created.projectId}, job ${created.jobId} (${created.directorMode})\n`);
    return await reportJob(rt, created.jobId, values.out);
  } finally {
    await rt.close();
  }
}

async function cmdRender(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string" },
      quality: { type: "string", default: "final" },
      version: { type: "string" },
      out: { type: "string" },
      workspace: { type: "string", default: DEFAULT_WORKSPACE },
    },
  });
  const input = RenderInput.parse({
    projectId: values.project,
    quality: values.quality,
    version: values.version ? Number(values.version) : undefined,
  });
  const rt = await bootRuntime();
  try {
    const caller: CallerContext = { workspaceId: values.workspace, keyId: "cli" };
    const queued = await createMotionService(rt).render(caller, input);
    process.stderr.write(`Render ${queued.renderId}, job ${queued.jobId}\n`);
    return await reportJob(rt, queued.jobId, values.out);
  } finally {
    await rt.close();
  }
}

async function cmdDoctor(): Promise<number> {
  const rt = await bootRuntime();
  try {
    const report = await rt.renderer.doctor({ ensureBrowser: false });
    print({ render: report, runtime: await doctorSummary(rt) });
    return report.ok ? 0 : 1;
  } finally {
    await rt.close();
  }
}

async function cmdKeys(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "create") throw new MotionError("VALIDATION", "Usage: pnpm motion keys create --name <label>");
  const { values } = parseArgs({
    args: rest,
    options: { name: { type: "string" }, workspace: { type: "string", default: DEFAULT_WORKSPACE } },
  });
  if (!values.name?.trim()) throw new MotionError("VALIDATION", "--name is required");
  const rt = await bootRuntime();
  try {
    const generated = generateApiKey();
    const record = await rt.repos.apiKeys.create({
      id: newId("key"),
      workspaceId: values.workspace,
      name: values.name.trim().slice(0, 120),
      hash: generated.hash,
      prefix: generated.prefix,
      createdAt: new Date().toISOString(),
    });
    process.stderr.write("Store this key now; it cannot be shown again.\n");
    print({ id: record.id, workspaceId: record.workspaceId, name: record.name, key: generated.key });
    return 0;
  } finally {
    await rt.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "create":
      return cmdCreate(args);
    case "render":
      return cmdRender(args);
    case "doctor":
      return cmdDoctor();
    case "schema":
      print(jsonSchemas());
      return 0;
    case "keys":
      return cmdKeys(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const e = toMotionError(err);
    process.stderr.write(`${e.code}: ${e.message}\n`);
    process.exit(1);
  },
);
