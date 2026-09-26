import type { MotionIR, MotionScene, QaIssue, ScenePatch } from "@motion-mcp/motion-ir";

/** Input budget for the task prompt (the system prompt and tool schemas are extra and small). */
export const MAX_TASK_PROMPT_TOKENS = 6000;

/** Cheap, conservative token estimate (~4 characters per token for English, JSON and HTML). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const WORKER_SYSTEM_PROMPT = [
  "You are a senior motion-graphics engineer implementing one HyperFrames scene as deterministic HTML/CSS/GSAP.",
  "Work only inside the current project directory using the provided file tools.",
  "Write only the file named in the task. Never touch motion-ir.json, hyperframes.json or other scenes.",
  "Keep the result deterministic: no Date.now, requestAnimationFrame, unseeded Math.random, network fetches or autoplay.",
  "When the file is complete, call submit_scene exactly once with the files you wrote and one or two sentences of notes.",
  "Do not explain your work in chat; the submit_scene call is the only result that counts.",
].join("\n");

/** Default contract for a scene sub-composition; the pipeline may pass a project-specific summary instead. */
export const DEFAULT_COMPOSITION_CONTRACT = [
  "- File compositions/<sceneId>.html wraps all markup in a single <template>.",
  '- The template root is <div data-composition-id="<sceneId>" data-start="0" data-duration="<scene duration>" data-width data-height> using scene-local time.',
  '- Every timed element has a unique id, class="clip", data-start (seconds) and data-duration.',
  '- Motion is one paused GSAP timeline registered as window.__timelines["<sceneId>"] = tl; scripts never play, seek or toggle visibility themselves.',
  "- Paint order uses CSS z-index. Asset paths resolve from the project root (assets/...).",
  "- Use brand colors and fonts from the video context; keep text inside the safe area and never overflow the frame.",
].join("\n");

export interface SceneContext {
  format: MotionIR["format"];
  brand: MotionIR["brand"];
  motionLanguage: MotionIR["motionLanguage"];
}

export interface ScenePromptInput {
  sceneId: string;
  sceneIR: MotionScene;
  /** Video-level context (format, brand, motion language) the scene must honour. */
  context?: SceneContext;
  /** Composition contract summary; defaults to `DEFAULT_COMPOSITION_CONTRACT`. */
  contract?: string;
  /** Relevant domain-pack snippets, most relevant first. Trimmed to fit the budget. */
  skills?: readonly string[];
}

export interface PatchPromptInput {
  sceneId: string;
  /** Deferred (non-deterministic) patch instructions. */
  patch?: ScenePatch;
  qaIssues?: readonly QaIssue[];
  sceneIR?: MotionScene;
  context?: SceneContext;
  contract?: string;
  skills?: readonly string[];
}

export interface BuiltPrompt {
  text: string;
  estimatedTokens: number;
  /** Number of snippets dropped or truncated to respect the budget. */
  trimmedSnippets: number;
}

export function sceneFilePath(sceneId: string): string {
  return `compositions/${sceneId}.html`;
}

const json = (value: unknown) => JSON.stringify(value);

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim()}`;
}

/** Append snippets in priority order while the whole prompt stays under the budget. */
function withSnippets(
  core: string[],
  tail: string[],
  skills: readonly string[] | undefined,
  budget: number,
): BuiltPrompt {
  const base = [...core, ...tail].join("\n\n");
  let remaining = budget - estimateTokens(base) - 20;
  const kept: string[] = [];
  let trimmed = 0;
  for (const [i, raw] of (skills ?? []).entries()) {
    const snippet = raw.trim();
    if (!snippet) continue;
    const header = `### Reference ${i + 1}\n`;
    const cost = estimateTokens(header + snippet) + 2;
    if (cost <= remaining) {
      kept.push(header + snippet);
      remaining -= cost;
      continue;
    }
    trimmed += 1;
    const room = (remaining - estimateTokens(header) - 4) * 4;
    if (room >= 400) {
      kept.push(`${header}${snippet.slice(0, room)}\n[truncated]`);
      remaining = 0;
    }
  }
  const parts = [...core];
  if (kept.length) parts.push(section("Reference snippets (domain pack)", kept.join("\n\n")));
  parts.push(...tail);
  const text = parts.join("\n\n");
  return { text, estimatedTokens: estimateTokens(text), trimmedSnippets: trimmed };
}

function contextSection(context: SceneContext | undefined): string[] {
  if (!context) return [];
  const { format, brand, motionLanguage } = context;
  return [
    section(
      "Video context",
      json({
        format: { width: format.width, height: format.height, fps: format.fps },
        brand: { colors: brand.colors, fonts: brand.fonts, radius: brand.radius, rules: brand.visualRules },
        motion: {
          tempo: motionLanguage.tempo,
          easing: motionLanguage.preferredEasing,
          avoidEasing: motionLanguage.avoidEasing,
          holdRatio: motionLanguage.holdRatio,
          maxSimultaneousObjects: motionLanguage.maxSimultaneousObjects,
          avoid: motionLanguage.avoid,
        },
      }),
    ),
  ];
}

export function buildScenePrompt(input: ScenePromptInput, budget = MAX_TASK_PROMPT_TOKENS): BuiltPrompt {
  const file = sceneFilePath(input.sceneId);
  const core = [
    `# Task: implement scene "${input.sceneId}"\nCreate ${file} from the scene IR below, then call submit_scene with files ["${file}"].`,
    section("Composition contract", input.contract ?? DEFAULT_COMPOSITION_CONTRACT),
    ...contextSection(input.context),
    section("Scene IR", json(input.sceneIR)),
  ];
  const tail = [
    section(
      "Acceptance",
      [
        `- Scene duration is exactly ${input.sceneIR.duration}s; every clip ends by then.`,
        "- Follow the choreography beats, easing tokens and visual hierarchy; honour constraints and avoid anti-patterns.",
        ...input.sceneIR.acceptance.map((a) => `- ${a}`),
      ].join("\n"),
    ),
  ];
  return withSnippets(core, tail, input.skills, budget);
}

const MAX_ISSUES = 20;

export function buildPatchPrompt(input: PatchPromptInput, budget = MAX_TASK_PROMPT_TOKENS): BuiltPrompt {
  const file = sceneFilePath(input.sceneId);
  const changes = (input.patch?.changes ?? []).map(
    (c, i) => `${i + 1}. [${c.type}${c.target ? ` @${c.target}` : ""}] ${c.instruction}`,
  );
  const issues = (input.qaIssues ?? [])
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, MAX_ISSUES)
    .map((q) => {
      const ev = q.evidence;
      const where = [
        ev?.time !== undefined ? `t=${ev.time}s` : "",
        ev?.selector ? `selector=${ev.selector}` : "",
        ev?.code ? `code=${ev.code}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `- ${q.severity.toUpperCase()} ${q.category} (${q.source})${where ? ` ${where}` : ""}: ${q.message.slice(0, 300)}`;
    });
  const dropped = (input.qaIssues?.length ?? 0) - issues.length;
  const core = [
    `# Task: revise scene "${input.sceneId}"\nRead ${file}, apply the changes and fix the issues below with minimal edits, then call submit_scene with files ["${file}"].`,
    section("Composition contract", input.contract ?? DEFAULT_COMPOSITION_CONTRACT),
    ...contextSection(input.context),
  ];
  if (input.sceneIR) core.push(section("Scene IR (current)", json(input.sceneIR)));
  const tail: string[] = [];
  if (changes.length) {
    const why = input.patch?.rationale ? `\nRationale: ${input.patch.rationale}` : "";
    tail.push(section("Requested changes", `${changes.join("\n")}${why}`));
  }
  if (issues.length) {
    tail.push(
      section(
        "QA issues",
        `${issues.join("\n")}${dropped > 0 ? `\n(${dropped} lower-priority issues omitted)` : ""}`,
      ),
    );
  }
  if (!changes.length && !issues.length) {
    tail.push(
      section(
        "Requested changes",
        "Re-validate the scene against the contract and fix anything that violates it.",
      ),
    );
  }
  return withSnippets(core, tail, input.skills, budget);
}

function severityRank(s: QaIssue["severity"]): number {
  return s === "error" ? 2 : s === "warn" ? 1 : 0;
}
