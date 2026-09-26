import type { Project } from "@motion-mcp/database";
import type { DomainPack } from "@motion-mcp/domain-pack";
import type { SearchInput, SearchOutput } from "./contract/tool-schemas.ts";

type DocType = SearchOutput["results"][number]["type"];

export interface SearchDoc {
  type: DocType;
  id: string;
  title: string;
  text: string;
}

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const EXACT_TITLE_BOOST = 10;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

function snippet(text: string, terms: Set<string>): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 60);
  const out = clean.slice(start, start + 200);
  return `${start > 0 ? "…" : ""}${out}${start + 200 < clean.length ? "…" : ""}`;
}

/**
 * In-process BM25 over titles (weighted) and bodies. Small corpora only: the workspace's projects plus the
 * static domain pack. Vector and Postgres full-text search replace this in a later phase.
 */
export function bm25Search(docs: SearchDoc[], query: string, limit: number): SearchOutput {
  const terms = [...new Set(tokenize(query))];
  const normalizedQuery = query.trim().toLowerCase();
  if (terms.length === 0 || docs.length === 0) return { results: [], exact: false };

  const tokenized = docs.map((d) => {
    const tokens = [
      ...Array.from({ length: TITLE_WEIGHT }, () => tokenize(d.title)).flat(),
      ...tokenize(d.text),
    ];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { doc: d, tf, length: tokens.length };
  });
  const avgLength = tokenized.reduce((s, d) => s + d.length, 0) / tokenized.length;
  const df = new Map<string, number>();
  for (const term of terms) df.set(term, tokenized.filter((d) => d.tf.has(term)).length);

  const scored = tokenized
    .map(({ doc, tf, length }) => {
      let score = 0;
      for (const term of terms) {
        const f = tf.get(term) ?? 0;
        if (f === 0) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (tokenized.length - n + 0.5) / (n + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * length) / avgLength));
      }
      const exact = doc.title.trim().toLowerCase() === normalizedQuery;
      if (exact) score += EXACT_TITLE_BOOST;
      return { doc, score, exact };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, limit);

  return {
    results: scored.map(({ doc, score }) => ({
      type: doc.type,
      id: doc.id,
      title: doc.title,
      snippet: snippet(doc.text || doc.title, new Set(terms)),
      score: Math.round(score * 1000) / 1000,
    })),
    exact: scored.some((r) => r.exact),
  };
}

export function projectDocs(projects: Project[]): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const p of projects) {
    const scenes = p.motionIR?.scenes ?? [];
    docs.push({
      type: "project",
      id: p.id,
      title: p.title,
      text: [p.brief, ...scenes.map((s) => s.intent)].join("\n"),
    });
    for (const s of scenes) {
      docs.push({
        type: "scene",
        id: `${p.id}/${s.id}`,
        title: `${p.title}: ${s.id}`,
        text: [s.role, s.intent, s.focalPoint].join("\n"),
      });
    }
  }
  return docs;
}

let packDocsCache: WeakMap<DomainPack, SearchDoc[]> | undefined;

/** Style profiles and knowledge entries of the domain pack (brand-inspired styles excluded). */
export function domainPackDocs(pack: DomainPack): SearchDoc[] {
  packDocsCache ??= new WeakMap();
  const cached = packDocsCache.get(pack);
  if (cached) return cached;
  const docs: SearchDoc[] = pack.styleIndex().map((s) => ({
    type: "style" as const,
    id: s.id,
    title: s.name,
    text: [s.id, s.family, s.summary, ...s.bestFor].join("\n"),
  }));
  const seen = new Set<string>();
  for (const role of ["director", "worker"] as const) {
    for (const s of pack.retrieve({ role, limit: 100, maxChars: 50_000 }).snippets) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      docs.push({ type: "pattern", id: s.id, title: s.id, text: s.text });
    }
  }
  packDocsCache.set(pack, docs);
  return docs;
}

export function searchDocs(docs: SearchDoc[], input: SearchInput): SearchOutput {
  const types = input.types && input.types.length > 0 ? new Set(input.types) : undefined;
  return bm25Search(types ? docs.filter((d) => types.has(d.type)) : docs, input.query, input.limit);
}
