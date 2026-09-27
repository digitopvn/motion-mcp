import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Async, EmptyState, PageHeader } from "../components/ui.tsx";
import { humanize } from "../lib/format.ts";
import type { SearchDocType, SearchOutput, SearchResult } from "../lib/types.ts";
import { useApi, useDocumentTitle } from "../lib/use-api.ts";

const GROUP_ORDER: SearchDocType[] = ["project", "scene", "recipe", "style", "pattern"];
const GROUP_LABEL: Record<SearchDocType, string> = {
  project: "Videos",
  scene: "Scenes",
  recipe: "Recipes",
  style: "Styles",
  pattern: "Patterns",
};

function resultLink(result: SearchResult): string | undefined {
  if (result.type === "project") return `/videos/${encodeURIComponent(result.id)}`;
  if (result.type === "recipe") return "/recipes";
  // The search index ids scenes as `<projectId>/<sceneId>` (packages/pipeline/src/search.ts).
  if (result.type === "scene" && result.id.includes("/")) {
    return `/videos/${encodeURIComponent(result.id.split("/")[0]!)}`;
  }
  return undefined;
}

function groupResults(results: SearchResult[]): { type: SearchDocType; items: SearchResult[] }[] {
  return GROUP_ORDER.map((type) => ({
    type,
    items: results.filter((r) => r.type === type).sort((a, b) => b.score - a.score),
  })).filter((g) => g.items.length > 0);
}

export function SearchPage() {
  useDocumentTitle("Search");
  const [params, setParams] = useSearchParams();
  const query = params.get("q")?.trim() ?? "";
  const [draft, setDraft] = useState(query);
  const search = useApi<SearchOutput>(query ? `/api/search?q=${encodeURIComponent(query)}` : null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = draft.trim();
    setParams(q ? { q } : {});
  }

  return (
    <>
      <PageHeader
        title="Search"
        intro="Find videos, scenes, recipes, styles and motion patterns in this workspace."
      />
      <form className="search-form" aria-label="Search the workspace" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="search-q">
          Search query
        </label>
        <input
          id="search-q"
          type="search"
          value={draft}
          maxLength={500}
          placeholder="e.g. kinetic typography launch teaser"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {query ? (
        <Async state={search} label="Searching">
          {(data) => {
            const groups = groupResults(data.results);
            if (groups.length === 0) {
              return (
                <EmptyState title={`No results for “${query}”`}>
                  <p>Try fewer or different words.</p>
                </EmptyState>
              );
            }
            return (
              <div className="search-results" aria-live="polite">
                {!data.exact ? <p className="muted small">Showing approximate matches.</p> : null}
                {groups.map((group) => (
                  <section key={group.type} aria-labelledby={`group-${group.type}`} className="result-group">
                    <h2 id={`group-${group.type}`} className="h4">
                      {GROUP_LABEL[group.type]} <span className="muted">({group.items.length})</span>
                    </h2>
                    <ul className="result-list">
                      {group.items.map((r) => {
                        const href = resultLink(r);
                        return (
                          <li key={`${r.type}:${r.id}`}>
                            <p className="result-title">
                              {href ? <Link to={href}>{r.title}</Link> : r.title}
                              <span className="tag">{humanize(r.type)}</span>
                            </p>
                            {r.snippet ? <p className="muted small">{r.snippet}</p> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            );
          }}
        </Async>
      ) : null}
    </>
  );
}
