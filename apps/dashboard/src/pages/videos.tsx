import { useState } from "react";
import { Link } from "react-router";
import { EmptyState, ErrorState, Loading, PageHeader } from "../components/ui.tsx";
import { VideoTable } from "../components/video-table.tsx";
import { errorMessage } from "../lib/api.ts";
import { api } from "../lib/client.ts";
import type { ProjectList } from "../lib/types.ts";
import { useApi, useDocumentTitle } from "../lib/use-api.ts";

const PAGE_SIZE = 25;

export function VideosPage() {
  useDocumentTitle("Videos");
  const first = useApi<ProjectList>(`/api/projects?limit=${PAGE_SIZE}`);
  const [more, setMore] = useState<ProjectList["projects"]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | undefined>(undefined);

  const nextCursor = cursor ?? first.data?.nextCursor;
  const projects = [...(first.data?.projects ?? []), ...more];

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await api.get<ProjectList>(
        `/api/projects?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setMore((current) => [...current, ...page.projects]);
      // An empty string marks the end so the first page's cursor is not reused.
      setCursor(page.nextCursor ?? "");
    } catch (error) {
      setMoreError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Videos"
        intro="Every project in this workspace, whether it came from the dashboard or an MCP client."
        actions={
          <Link className="btn btn-primary" to="/videos/new">
            New video
          </Link>
        }
      />
      {first.data === undefined ? (
        first.error ? (
          <ErrorState message={first.error} onRetry={first.reload} />
        ) : (
          <Loading label="Loading videos" />
        )
      ) : projects.length === 0 ? (
        <EmptyState title="No videos yet">
          <p>Start from a brief or a saved recipe.</p>
          <Link className="btn btn-primary btn-sm" to="/videos/new">
            New video
          </Link>
        </EmptyState>
      ) : (
        <>
          <VideoTable projects={projects} caption="Videos" />
          {moreError ? <ErrorState message={moreError} onRetry={loadMore} /> : null}
          {nextCursor ? (
            <div className="list-more">
              <button type="button" className="btn btn-quiet" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
