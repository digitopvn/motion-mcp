# Search and Taste Memory

`motion_search` and, later, director retrieval share one search service. The
current implementation is a small in-process ranker. The hybrid search and
Taste Memory below are **planned** for the search and Taste Memory phase
([ROADMAP.md](ROADMAP.md)), in `packages/search` and `packages/taste-memory`.

## Current search

`packages/pipeline/src/search.ts` ranks with in-process BM25 over document
titles (weighted) and bodies:

- The corpus is the caller's workspace projects and their scenes, plus the
  domain pack's style index and knowledge entries. Brand-inspired styles are
  excluded.
- The result `type` is one of the `SearchDocType` values in the tool schema.
  `recipe` is reserved; no recipes are indexed yet.
- A result whose title equals the normalized query gets a large boost, and the
  response sets `exact: true` when any result matched exactly.

This is sized for small corpora and is rebuilt per query from the repositories.
The director does not retrieve from it yet; it gets domain-pack snippets
through tag retrieval instead
([ADR 0012](decisions/0012-domain-pack-lift-and-wrap.md)).

## Planned hybrid search

```
query ──► exact-match check ──hit──► return (exact: true)
             │ miss
             ├─► lexical: PostgreSQL full-text (tsvector, ts_rank_cd)   top 50
             ├─► semantic: pgvector cosine similarity on embeddings      top 50
             ▼
          Reciprocal Rank Fusion (k = 60)
             ▼
          ambiguous? ──yes──► Jev rerank of the top candidates
             │ no
             ▼
          top N
```

1. **Exact-match short-circuit.** When the query equals a document id, slug or
   alias after normalization (lower case, trimmed), that document is returned
   directly with no scoring. Examples are a style id, a recipe slug, a registry
   block name or a project id.
2. **Lexical ranking.** PostgreSQL full-text search over a weighted `tsvector`
   (title, then tags, then body). `ts_rank_cd` is not true BM25, but it covers
   the same need for keyword precision without adding a search engine.
3. **Semantic ranking.** The `pgvector` column on `search_documents`, scoped by
   workspace, with global documents included.
4. **Fusion.** `score(d) = Σ 1 / (60 + rank_i(d))` over both lists. RRF needs
   no score normalization between the two rankers.
5. **Jev rerank, only when ambiguous.** A result set is ambiguous when the top
   two fused scores are within a configured margin and belong to different
   documents. Jev then scores those candidates against the query. Otherwise no
   model is called.

The `search_documents` table, with a generated `tsvector` and a vector column,
is already defined in `packages/database/src/schema.ts`. Planned document
types are domain-pack styles, patterns and antipatterns, HyperFrames registry
blocks for the pinned version, recipes, projects and scenes, asset descriptions
and Taste Memory preferences. Global documents are re-indexed when the domain
pack or the pinned HyperFrames version changes.

## Taste Memory

**Planned.** Taste Memory records what a workspace accepted, rejected or edited,
and feeds that back to the director.

- **Signals.** Accepted critique patches, `motion_edit` instructions and the
  patches they produced, published renders, and abandoned versions each write a
  `taste_preferences` row, tagged with the scene role and style dimension.
- **Retrieval.** Before Stage 1+2, the director queries the workspace's
  preferences using the brief and the chosen style, and injects a short
  preference slice after the cacheable prefix. The director already accepts a
  taste context block for this. The retrieved preferences are listed in the
  trace, so their influence can be audited.
- **Scope.** Preferences stay within one workspace and never cross workspaces.

## Open design points

- The embedding model has not been chosen. The drizzle schema provisionally
  sizes the vector column at 1536 dimensions; the final choice must be recorded
  in the search package's configuration and in an ADR.
- The ambiguity margin and the size of the rerank set still need tuning against
  real queries.
