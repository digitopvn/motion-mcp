import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AspectPreset, SceneRole } from "@motion-mcp/motion-ir";
import { MotionError } from "@motion-mcp/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  Energy,
  KNOWLEDGE_FILES,
  type KnowledgeEntry,
  KnowledgeFile,
  KnowledgeKind,
  OverridesFile,
  PipelineStep,
  type StyleIndexEntry,
  StyleIndexFile,
  StyleProfile,
} from "./schema.ts";

/** Default location of the vendored + authored pack files. */
export const DEFAULT_PACK_DIR = fileURLToPath(new URL("../pack/", import.meta.url));

export const RetrieveQuery = z.object({
  role: z.enum(["director", "worker"]),
  sceneRole: SceneRole.optional(),
  styleIds: z.array(z.string().max(64)).max(8).optional(),
  format: AspectPreset.optional(),
  energy: Energy.optional(),
  step: PipelineStep.optional(),
  /** Restrict retrieval to some knowledge files (for example only the rubric during critique). */
  kinds: z.array(KnowledgeKind).min(1).optional(),
  limit: z.number().int().min(1).max(100).default(12),
  /** Hard cap on the length of the rendered `text`. */
  maxChars: z.number().int().min(80).max(50_000).default(3000),
});
export type RetrieveQuery = z.input<typeof RetrieveQuery>;

export interface Snippet {
  /** `<kind>/<entry id>`, stable across releases for tracing which guidance a prompt used. */
  id: string;
  kind: KnowledgeKind;
  text: string;
  invariant: boolean;
  score: number;
}

export interface RetrievalResult {
  snippets: Snippet[];
  /** Prompt-ready bullet list; `text.length <= maxChars`. */
  text: string;
  /** True when matching entries were dropped because of `limit` or `maxChars`. */
  truncated: boolean;
}

export interface StyleSummary {
  id: string;
  name: string;
  family: string;
  energy: number;
  bestFor: string[];
  summary: string;
  brandInspired: boolean;
}

export interface StyleMatch extends StyleSummary {
  score: number;
}

interface IndexedEntry {
  kind: KnowledgeKind;
  order: number;
  entry: KnowledgeEntry;
}

interface LoadedPack {
  entries: IndexedEntry[];
  styles: StyleSummary[];
  aliases: Map<string, string[]>;
  profiles: Map<string, StyleProfile>;
}

const renderLine = (text: string) => `- ${text}`;

/** Score reported for invariants; above any facet score (max 9) so ranking stays explicit and JSON-safe. */
export const INVARIANT_SCORE = 100;

const STOPWORDS = new Set([
  "an",
  "and",
  "the",
  "of",
  "for",
  "with",
  "in",
  "on",
  "to",
  "like",
  "style",
  "styled",
  "look",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

async function readYaml(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new MotionError("CONFIG", `Domain pack file missing: ${basename(path)}`, { cause: err });
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new MotionError("CONFIG", `Domain pack file is not valid YAML: ${basename(path)}`, { cause: err });
  }
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MotionError("CONFIG", `Domain pack file ${file} failed validation`, {
      details: { issues: result.error.issues.slice(0, 10) },
    });
  }
  return result.data;
}

/**
 * Motion knowledge pack: vendored style profiles plus normalized, tagged guidance entries.
 * Call `load()` once (it is cached); every other method is synchronous and allocation-light so
 * it can run per scene when building worker prompts.
 */
export class DomainPack {
  readonly packDir: string;
  private loading?: Promise<LoadedPack>;
  private data?: LoadedPack;

  constructor(options: { packDir?: string } = {}) {
    this.packDir = options.packDir ?? DEFAULT_PACK_DIR;
  }

  /** Parse and validate every pack file once. Safe to call repeatedly or concurrently. */
  async load(): Promise<this> {
    this.loading ??= this.readPack();
    try {
      this.data = await this.loading;
    } catch (err) {
      this.loading = undefined;
      throw err;
    }
    return this;
  }

  get loaded(): boolean {
    return this.data !== undefined;
  }

  /** Total authored entries per knowledge file. */
  entryCounts(): Record<KnowledgeKind, number> {
    const counts = Object.fromEntries(KNOWLEDGE_FILES.map((k) => [k, 0])) as Record<KnowledgeKind, number>;
    for (const e of this.pack().entries) counts[e.kind] += 1;
    return counts;
  }

  /**
   * Ranked, budgeted guidance for one prompt. Invariants are always included first when they match the
   * role, the pipeline step (entries tagged `any` match every step) and `kinds`; scene, style, format and
   * energy never exclude an invariant. Other entries must match every facet the query sets (an empty tag
   * list on the entry is a wildcard) and are ordered by how many facets they match explicitly.
   */
  retrieve(input: RetrieveQuery): RetrievalResult {
    const q = RetrieveQuery.parse(input);
    const styleIds = q.styleIds && q.styleIds.length > 0 ? new Set(q.styleIds) : undefined;

    const invariants: Snippet[] = [];
    const scored: Array<Snippet & { order: number }> = [];
    for (const { kind, order, entry } of this.pack().entries) {
      const t = entry.tags;
      if (t.role !== "both" && t.role !== q.role) continue;
      if (q.kinds && !q.kinds.includes(kind)) continue;
      const base = { id: `${kind}/${entry.id}`, kind, text: entry.text, invariant: t.invariant };
      if (t.invariant) {
        if (q.step === undefined || t.pipeline_step === "any" || t.pipeline_step === q.step) {
          invariants.push({ ...base, score: INVARIANT_SCORE });
        }
        continue;
      }
      let score = 0;
      const facet = <T>(tags: readonly T[], wanted: T | undefined): boolean => {
        if (wanted === undefined || tags.length === 0) return true;
        if (!tags.includes(wanted)) return false;
        score += 2;
        return true;
      };
      if (!facet(t.scene_types, q.sceneRole)) continue;
      if (!facet(t.format, q.format)) continue;
      if (!facet(t.energy, q.energy)) continue;
      if (styleIds && t.styles.length > 0) {
        if (!t.styles.some((s) => styleIds.has(s))) continue;
        score += 2;
      }
      if (q.step !== undefined && t.pipeline_step !== "any") {
        if (t.pipeline_step !== q.step) continue;
        score += 1;
      }
      scored.push({ ...base, score, order });
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);

    const ranked: Snippet[] = [...invariants, ...scored.map(({ order: _order, ...s }) => s)];
    const picked: Snippet[] = [];
    const lines: string[] = [];
    let used = 0;
    for (const snippet of ranked) {
      if (picked.length >= q.limit) break;
      const line = renderLine(snippet.text);
      const cost = line.length + (lines.length > 0 ? 1 : 0);
      if (used + cost > q.maxChars) continue;
      picked.push(snippet);
      lines.push(line);
      used += cost;
    }
    return { snippets: picked, text: lines.join("\n"), truncated: picked.length < ranked.length };
  }

  /** Compact style list for the director. Brand-inspired styles are excluded unless explicitly requested. */
  styleIndex(options: { excludeBrandInspired?: boolean } = {}): StyleSummary[] {
    const exclude = options.excludeBrandInspired ?? true;
    return this.pack().styles.filter((s) => !(exclude && s.brandInspired));
  }

  /** `styleIndex` rendered as prompt lines, cut to `maxChars` on a line boundary. */
  styleIndexText(options: { excludeBrandInspired?: boolean; maxChars?: number } = {}): string {
    const maxChars = options.maxChars ?? 6000;
    const lines: string[] = [];
    let used = 0;
    for (const s of this.styleIndex(options)) {
      const line = `- ${s.id} (energy ${s.energy}; ${s.bestFor.join(", ")}): ${s.summary}`;
      const cost = line.length + (lines.length > 0 ? 1 : 0);
      if (used + cost > maxChars) break;
      lines.push(line);
      used += cost;
    }
    return lines.join("\n");
  }

  /** Keyword lookup over ids, aliases, names, best-for tags and summaries. */
  findStyles(query: string, options: { limit?: number; includeBrandInspired?: boolean } = {}): StyleMatch[] {
    const limit = options.limit ?? 5;
    const normalized = query.trim().toLowerCase();
    const tokens = new Set(tokenize(normalized));
    if (tokens.size === 0) return [];
    const { aliases } = this.pack();
    const matches: StyleMatch[] = [];
    for (const style of this.styleIndex({ excludeBrandInspired: !options.includeBrandInspired })) {
      const styleAliases = aliases.get(style.id) ?? [];
      let score = 0;
      if (style.id === normalized || style.name.toLowerCase() === normalized) score += 100;
      if (styleAliases.some((a) => a.toLowerCase() === normalized)) score += 80;
      const idTokens = new Set(tokenize(style.id));
      const aliasTokens = new Set(styleAliases.flatMap(tokenize));
      const nameTokens = new Set(tokenize(style.name));
      const tagTokens = new Set(style.bestFor.flatMap(tokenize));
      const summaryTokens = new Set(tokenize(style.summary));
      for (const token of tokens) {
        if (idTokens.has(token)) score += 5;
        if (aliasTokens.has(token)) score += 4;
        if (nameTokens.has(token)) score += 3;
        if (tagTokens.has(token)) score += 3;
        if (summaryTokens.has(token)) score += 1;
      }
      if (score > 0) matches.push({ ...style, score });
    }
    matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return matches.slice(0, limit);
  }

  /** Full vendored profile for a resolved style id (no brand filtering: the caller already chose it). */
  getStyleProfile(id: string): StyleProfile | undefined {
    return this.pack().profiles.get(id);
  }

  private pack(): LoadedPack {
    if (!this.data) throw new MotionError("INTERNAL", "DomainPack.load() must complete before use");
    return this.data;
  }

  private async readPack(): Promise<LoadedPack> {
    const dir = this.packDir;
    const index = parseWith(
      StyleIndexFile,
      await readYaml(join(dir, "styles/index.yaml")),
      "styles/index.yaml",
    );
    const overrides = parseWith(
      OverridesFile,
      (await readYaml(join(dir, "overrides.yaml"))) ?? {},
      "overrides.yaml",
    );

    const styleIds = new Set<string>();
    for (const s of index.styles) {
      if (styleIds.has(s.id))
        throw new MotionError("CONFIG", `Duplicate style id ${s.id} in styles/index.yaml`);
      styleIds.add(s.id);
    }
    for (const id of Object.keys(overrides.styles)) {
      if (!styleIds.has(id)) throw new MotionError("CONFIG", `overrides.yaml references unknown style ${id}`);
    }

    const brandInspired = (s: StyleIndexEntry) =>
      overrides.styles[s.id]?.brand_inspired ?? s.family === "brand-inspired";
    const styles: StyleSummary[] = index.styles.map((s) => ({
      id: s.id,
      name: s.name,
      family: s.family,
      energy: s.energy,
      bestFor: s.best_for,
      summary: s.summary,
      brandInspired: brandInspired(s),
    }));
    const aliases = new Map(index.styles.map((s) => [s.id, s.aliases]));

    const profiles = new Map<string, StyleProfile>();
    const profileDir = join(dir, "styles/profiles");
    for (const file of (await readdir(profileDir)).filter((f) => f.endsWith(".yaml")).sort()) {
      const profile = parseWith(
        StyleProfile,
        await readYaml(join(profileDir, file)),
        `styles/profiles/${file}`,
      );
      if (`${profile.id}.yaml` !== file) {
        throw new MotionError("CONFIG", `Profile ${file} declares id ${profile.id}`);
      }
      if (!styleIds.has(profile.id))
        throw new MotionError("CONFIG", `Profile ${profile.id} is not in the index`);
      profiles.set(profile.id, profile);
    }
    for (const id of styleIds) {
      if (!profiles.has(id)) throw new MotionError("CONFIG", `Style ${id} has no profile file`);
    }

    const entries: IndexedEntry[] = [];
    for (const kind of KNOWLEDGE_FILES) {
      const file = `${kind}.yaml`;
      const parsed = parseWith(KnowledgeFile, await readYaml(join(dir, file)), file);
      if (parsed.kind !== kind) throw new MotionError("CONFIG", `${file} declares kind ${parsed.kind}`);
      const seen = new Set<string>();
      for (const entry of parsed.entries) {
        if (seen.has(entry.id)) throw new MotionError("CONFIG", `Duplicate entry id ${entry.id} in ${file}`);
        seen.add(entry.id);
        const unknown = entry.tags.styles.filter((s) => !styleIds.has(s));
        if (unknown.length > 0) {
          throw new MotionError(
            "CONFIG",
            `${file}#${entry.id} references unknown styles: ${unknown.join(", ")}`,
          );
        }
        entries.push({ kind, order: entries.length, entry });
      }
    }
    return { entries, styles, aliases, profiles };
  }
}

const shared = new Map<string, Promise<DomainPack>>();

/** Process-wide cached pack per directory. */
export function loadDomainPack(packDir: string = DEFAULT_PACK_DIR): Promise<DomainPack> {
  let pending = shared.get(packDir);
  if (!pending) {
    pending = new DomainPack({ packDir }).load();
    pending.catch(() => shared.delete(packDir));
    shared.set(packDir, pending);
  }
  return pending;
}
