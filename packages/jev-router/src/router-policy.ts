import { estimateCost } from "@motion-mcp/llm";
import { MECHANICAL_CATEGORIES, type QaCategory, type QaIssue } from "@motion-mcp/motion-ir";
import type { Span } from "@motion-mcp/observability";
import { type MotionConfig, MotionError, redact } from "@motion-mcp/shared";
import type { ChoiceQuestion, DecisionClient, DecisionState } from "./decision-types.ts";

export const ROOT_CAUSES = [
  "creative_direction",
  "implementation",
  "asset_quality",
  "animation",
  "timing",
  "typography",
  "layout",
  "render_bug",
  "audio",
  "user_intent_mismatch",
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export const WORKERS = ["pi", "hyperframes", "ffmpeg", "asset", "audio", "vision", "opus"] as const;
export type Worker = (typeof WORKERS)[number];

export type DirectorModeName = "host-opus" | "internal-opus" | "custom";

export interface IssueClassification {
  issueId: string;
  rootCause: RootCause;
  cheapFixable: boolean;
  worker: Worker;
  needsOpus: boolean;
  confidence: number;
  /** `rules` for mechanical short-circuits, otherwise the adapter that answered the root-cause question. */
  decidedBy: string;
}

export interface IssueContext {
  directorMode: DirectorModeName;
  sceneRole?: string;
  /** Cheap (Pi / deterministic) fix attempts that already failed for this issue. */
  attempts?: number;
}

export interface RouterDeps {
  decisions: DecisionClient;
  span: Span;
}

/** Cheap attempts after which a surviving issue escalates to creative judgment. */
export const MAX_CHEAP_ATTEMPTS = 2;
export const CHEAP_FIXABLE_THRESHOLD = 0.5;

const MECHANICAL_ROUTES: Partial<Record<QaCategory, { rootCause: RootCause; worker: Worker }>> = {
  text_clipping: { rootCause: "layout", worker: "pi" },
  overflow: { rootCause: "layout", worker: "pi" },
  misalignment: { rootCause: "layout", worker: "pi" },
  collision: { rootCause: "layout", worker: "pi" },
  safe_area: { rootCause: "layout", worker: "pi" },
  low_contrast: { rootCause: "typography", worker: "pi" },
  unreadable_text: { rootCause: "typography", worker: "pi" },
  timing_mismatch: { rootCause: "timing", worker: "pi" },
  empty_frame: { rootCause: "implementation", worker: "pi" },
  runtime_error: { rootCause: "implementation", worker: "pi" },
  lint_error: { rootCause: "implementation", worker: "pi" },
  broken_image: { rootCause: "asset_quality", worker: "asset" },
  asset_resolution: { rootCause: "asset_quality", worker: "asset" },
  render_failure: { rootCause: "render_bug", worker: "hyperframes" },
};

/** Root causes that creative judgment can fix; others (assets, renderer, audio) never go to Opus. */
const OPUS_FIXABLE: ReadonlySet<RootCause> = new Set([
  "creative_direction",
  "user_intent_mismatch",
  "animation",
  "timing",
  "typography",
  "layout",
  "implementation",
]);

const WORKER_FOR: Record<RootCause, Worker> = {
  creative_direction: "opus",
  user_intent_mismatch: "opus",
  implementation: "pi",
  animation: "pi",
  timing: "pi",
  typography: "pi",
  layout: "pi",
  asset_quality: "asset",
  render_bug: "hyperframes",
  audio: "audio",
};

const ROOT_CAUSE_DESCRIPTIONS: Record<RootCause, string> = {
  creative_direction: "the concept, hierarchy or taste is wrong; needs new creative direction",
  implementation: "the code does not implement the scene IR correctly",
  asset_quality: "an image, video or icon is missing, broken or low quality",
  animation: "motion choice or easing is wrong for the intent",
  timing: "pacing, holds or durations are off",
  typography: "type size, weight, font or readability",
  layout: "positioning, spacing, alignment or overflow",
  render_bug: "renderer or pipeline failure unrelated to the design",
  audio: "music, voice or sound effects",
  user_intent_mismatch: "the result does not match what the user asked for",
};

/** Is a director needed? A valid host spec means no internal director call. Pure. */
export function routeIntent(
  brief: string,
  hasCreativeSpec: boolean,
): { directorNeeded: boolean; reason: string } {
  if (hasCreativeSpec) return { directorNeeded: false, reason: "host supplied a creativeSpec" };
  if (!brief?.trim()) throw new MotionError("VALIDATION", "A brief or a creativeSpec is required");
  return { directorNeeded: true, reason: "brief needs creative direction" };
}

/**
 * Classify a QA issue. Mechanical categories resolve by rules with no model call; creative issues ask the
 * decision client for `root_cause` and `cheap_fixable`.
 */
export async function classifyIssue(
  issue: QaIssue,
  context: IssueContext,
  deps: RouterDeps,
): Promise<IssueClassification> {
  const attempts = context.attempts ?? 0;
  const mechanical = MECHANICAL_CATEGORIES.has(issue.category)
    ? MECHANICAL_ROUTES[issue.category]
    : undefined;
  if (mechanical) {
    return deps.span.run(
      "jev.route",
      async (s) => {
        const exhausted = attempts >= MAX_CHEAP_ATTEMPTS;
        const escalate = exhausted && OPUS_FIXABLE.has(mechanical.rootCause);
        const result: IssueClassification = {
          issueId: issue.id,
          rootCause: mechanical.rootCause,
          cheapFixable: !exhausted,
          worker: escalate ? "opus" : mechanical.worker,
          needsOpus: escalate,
          confidence: 1,
          decidedBy: "rules",
        };
        s.setAttributes({
          "jev.adapter": "rules",
          "jev.answer": `${result.rootCause}/${result.worker}`,
          "jev.latency_ms": 0,
          "jev.shortcircuit": true,
        });
        return result;
      },
      { "jev.question": "classify_issue", "jev.kind": "mechanical", "qa.category": issue.category },
    );
  }

  const state: DecisionState = {
    issue: {
      category: issue.category,
      severity: issue.severity,
      source: issue.source,
      message: redact(issue.message).slice(0, 400),
    },
    sceneRole: context.sceneRole,
    attempts,
    directorMode: context.directorMode,
  };
  const rootQuestion: ChoiceQuestion<RootCause> = {
    kind: "choice",
    id: "root_cause",
    instructions: "What is the root cause of this QA issue in a motion-design video?",
    state,
    options: ROOT_CAUSE_DESCRIPTIONS,
    rule: () => "creative_direction",
  };
  const root = await deps.decisions.decide(rootQuestion, deps.span);
  const rootCause: RootCause = root.value;
  const cheap = await deps.decisions.decide(
    {
      kind: "yesno",
      id: "cheap_fixable",
      instructions:
        "Can a cheap coding worker fix this with a local change to the scene, without new creative direction?",
      state: { ...state, rootCause },
      criteria: { yes: "a local, mechanical change fixes it", no: "it needs creative judgment" },
      rule: () =>
        attempts >= MAX_CHEAP_ATTEMPTS
          ? 0.1
          : OPUS_FIXABLE.has(rootCause) && WORKER_FOR[rootCause] === "pi"
            ? 0.6
            : 0.2,
    },
    deps.span,
  );
  const cheapFixable = attempts < MAX_CHEAP_ATTEMPTS && cheap.value >= CHEAP_FIXABLE_THRESHOLD;
  const needsOpus = !cheapFixable && OPUS_FIXABLE.has(rootCause);
  const cheapWorker = WORKER_FOR[rootCause] === "opus" ? "pi" : WORKER_FOR[rootCause];
  return {
    issueId: issue.id,
    rootCause,
    cheapFixable,
    worker: needsOpus ? "opus" : cheapWorker,
    needsOpus,
    confidence: Math.min(root.confidence, Math.max(cheap.value, 1 - cheap.value)),
    decidedBy: root.adapter,
  };
}

export interface CritiqueLimits {
  /** Max Opus critiques per scene per job. */
  perScene: number;
  /** Max Opus critiques per job. */
  perJob: number;
  /** Max revision loops per job. */
  maxLoops: number;
}

export const DEFAULT_CRITIQUE_LIMITS: CritiqueLimits = { perScene: 1, perJob: 2, maxLoops: 3 };

/** Stage 3 token budget used for the pre-flight cost estimate. */
export const CRITIQUE_TOKEN_ESTIMATE = { inputTokens: 8000, outputTokens: 2000 } as const;
const REFERENCE_OPUS_MODEL = "anthropic/claude-opus-5.5";

/** Estimated cost of one critique; unknown models are priced as Opus (conservative). */
export function estimateCritiqueCostUsd(model: string): number {
  return (
    estimateCost(model, CRITIQUE_TOKEN_ESTIMATE) ??
    estimateCost(REFERENCE_OPUS_MODEL, CRITIQUE_TOKEN_ESTIMATE)!
  );
}

export interface EscalationInput {
  issues: IssueClassification[];
  loop: number;
  budgetRemainingUsd: number;
  mode: DirectorModeName;
  /** Critique model id (director or custom model); ignored in host mode. */
  critiqueModel: string;
  critiquesForScene: number;
  critiquesForJob: number;
  limits?: Partial<CritiqueLimits>;
}

export interface PolicyVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Escalate a scene to Opus critique only for creative issues, within loop/scene/job caps and, for internal
 * critiques, only when the remaining budget covers the estimated critique cost. Pure.
 */
export function shouldEscalateToOpus(input: EscalationInput): PolicyVerdict & { estimatedCostUsd: number } {
  const limits = { ...DEFAULT_CRITIQUE_LIMITS, ...input.limits };
  const estimatedCostUsd = input.mode === "host-opus" ? 0 : estimateCritiqueCostUsd(input.critiqueModel);
  const verdict = (ok: boolean, reason: string) => ({ ok, reason, estimatedCostUsd });
  if (!input.issues.some((i) => i.needsOpus)) return verdict(false, "no issue needs creative judgment");
  if (input.loop >= limits.maxLoops) return verdict(false, `revision loop cap ${limits.maxLoops} reached`);
  if (input.critiquesForScene >= limits.perScene)
    return verdict(false, "scene already had its Opus critique");
  if (input.critiquesForJob >= limits.perJob)
    return verdict(false, `job critique cap ${limits.perJob} reached`);
  if (input.mode === "host-opus")
    return verdict(true, "creative issue; host critique request (no internal cost)");
  if (input.budgetRemainingUsd < estimatedCostUsd) {
    return verdict(
      false,
      `budget $${input.budgetRemainingUsd.toFixed(4)} < critique estimate $${estimatedCostUsd.toFixed(4)}`,
    );
  }
  return verdict(true, "creative issue within caps and budget");
}

export interface RenderInput {
  kind: "preview" | "final";
  lintErrors: number;
  checkErrors: number;
  /** Open issues with severity error (after classification). */
  openErrors?: number;
  changedSinceLastRender: boolean;
  budgetRemainingUsd: number;
  estimatedRenderCostUsd: number;
}

/** Render only when it can pass its gate, something changed, and the budget covers it. Pure. */
export function isRenderJustified(input: RenderInput): PolicyVerdict {
  if (input.lintErrors > 0) return { ok: false, reason: `${input.lintErrors} lint errors open` };
  if (input.kind === "final" && input.checkErrors > 0) {
    return { ok: false, reason: `final render requires a clean check (${input.checkErrors} errors)` };
  }
  if (input.kind === "final" && (input.openErrors ?? 0) > 0) {
    return { ok: false, reason: `${input.openErrors} error-severity issues open` };
  }
  if (!input.changedSinceLastRender) return { ok: false, reason: "nothing changed since the last render" };
  if (input.budgetRemainingUsd < input.estimatedRenderCostUsd) {
    return { ok: false, reason: "remaining budget does not cover the render" };
  }
  return { ok: true, reason: `${input.kind} render justified` };
}

export interface AssetInput {
  /** Paid with the workspace's own provider key: no credits, so only the count cap applies. */
  byok: boolean;
  generatedForJob: number;
  /** The job's image allowance (quoted and reserved up front). */
  maxPerJob: number;
  budgetRemainingUsd: number;
  estimatedCostUsd: number;
}

/** Generate a scene asset only within the job's allowance and, when the platform pays, its budget. Pure. */
export function shouldGenerateAsset(input: AssetInput): PolicyVerdict {
  if (input.generatedForJob >= input.maxPerJob) {
    return { ok: false, reason: `asset cap ${input.maxPerJob} reached` };
  }
  if (!input.byok && input.budgetRemainingUsd < input.estimatedCostUsd) {
    return { ok: false, reason: "remaining budget does not cover the asset" };
  }
  return { ok: true, reason: input.byok ? "workspace key" : "within allowance and budget" };
}

const NEVER_RETRY = new Set([
  "VALIDATION",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFIG",
  "NOT_FOUND",
]);

export interface RetryInput {
  error: unknown;
  /** Attempts already made (1 after the first failure). */
  attempt: number;
  maxAttempts?: number;
}

/** Retry transient failures with exponential backoff. Pure. */
export function shouldRetry(input: RetryInput): PolicyVerdict & { delayMs: number } {
  const max = input.maxAttempts ?? 3;
  if (input.attempt >= max) return { ok: false, reason: `attempt cap ${max} reached`, delayMs: 0 };
  const err = input.error;
  const code = err instanceof MotionError ? err.code : undefined;
  if (code && NEVER_RETRY.has(code)) return { ok: false, reason: `${code} is not retryable`, delayMs: 0 };
  const transient = err instanceof MotionError ? err.retryable || code === "TIMEOUT" : false;
  if (!transient) return { ok: false, reason: "error is not transient", delayMs: 0 };
  return {
    ok: true,
    reason: `transient ${code}`,
    delayMs: Math.min(15_000, 1000 * 2 ** (input.attempt - 1)),
  };
}

export type ModelTask = "direction" | "critique" | "polish" | "code" | "decision" | "vision";
export type ModelConfig = Pick<
  MotionConfig,
  "DIRECTOR_MODEL" | "CODER_MODEL" | "DECISION_MODEL" | "VISION_MODEL"
>;

/** Configured model id for a task. Model ids are configuration, never code. */
export function selectModel(task: ModelTask, config: ModelConfig): string {
  switch (task) {
    case "direction":
    case "critique":
    case "polish":
      return config.DIRECTOR_MODEL;
    case "code":
      return config.CODER_MODEL;
    case "decision":
      return config.DECISION_MODEL;
    case "vision":
      return config.VISION_MODEL;
  }
}
