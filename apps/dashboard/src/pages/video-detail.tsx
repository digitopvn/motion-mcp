import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { TracePanel } from "../components/trace-panel.tsx";
import {
  CopyButton,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  ProgressBar,
  StatusBadge,
} from "../components/ui.tsx";
import { api } from "../lib/client.ts";
import { formatCredits, formatDate, formatUsd, humanize } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";
import type { IrScene, ProjectDetail, PublishOutput, RenderOutput, RenderSummary } from "../lib/types.ts";
import { useAction, useApi, useDocumentTitle } from "../lib/use-api.ts";

const POLL_MS = 3000;
const ACTIVE_STATES = new Set(["queued", "running"]);

/** Picks the render to show first: newest playable final, else newest playable preview. */
function pickRender(renders: RenderSummary[]): RenderSummary | undefined {
  const playable = renders
    .filter((r) => r.status === "succeeded" && r.url)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return playable.find((r) => r.quality === "final") ?? playable[0];
}

function irScenes(ir: Record<string, unknown> | undefined): IrScene[] {
  const scenes = ir?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes.filter(
    (s): s is IrScene => typeof s === "object" && s !== null && typeof (s as IrScene).id === "string",
  );
}

export function VideoDetailPage() {
  const { id = "" } = useParams();
  const { refresh } = useSession();
  const path = `/api/projects/${encodeURIComponent(id)}?include=versions,renders,usage,trace,ir`;
  const detail = useApi<ProjectDetail>(id ? path : null);
  const [selectedRender, setSelectedRender] = useState<string | undefined>(undefined);
  const [published, setPublished] = useState<Record<string, string>>({});
  const renderAction = useAction();
  const publishAction = useAction();

  const title = detail.data?.project.title || "Video";
  useDocumentTitle(title);

  const jobActive = detail.data?.job ? ACTIVE_STATES.has(detail.data.job.state) : false;
  const { reload } = detail;

  // Poll while a job is running; each response re-arms the timer, so requests never overlap.
  useEffect(() => {
    if (!jobActive || detail.loading) return;
    const timer = window.setTimeout(reload, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [jobActive, detail.loading, reload]);

  // Refresh the balance when a job settles, since it releases or charges held credits.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !jobActive) refresh();
    wasActive.current = jobActive;
  }, [jobActive, refresh]);

  if (!detail.data) {
    return detail.error ? (
      <>
        <PageHeader eyebrow="Videos" title="Video" />
        <ErrorState message={detail.error} onRetry={detail.reload} />
        <p>
          <Link to="/videos">Back to videos</Link>
        </p>
      </>
    ) : (
      <Loading label="Loading video" />
    );
  }

  const { project, job, renders = [], versions = [], qaIssues = [], usage, ir } = detail.data;
  const current = renders.find((r) => r.id === selectedRender && r.url) ?? pickRender(renders);
  const scenes = irScenes(ir);
  const hasFinal = renders.some(
    (r) => r.quality === "final" && (r.status === "succeeded" || ACTIVE_STATES.has(r.status)),
  );

  async function renderFinal() {
    const result = await renderAction.run(() =>
      api.post<RenderOutput>(`/api/projects/${encodeURIComponent(project.id)}/render`, { quality: "final" }),
    );
    if (result) {
      refresh();
      reload();
    }
  }

  async function publish(render: RenderSummary) {
    const result = await publishAction.run(() =>
      api.post<PublishOutput>(`/api/renders/${encodeURIComponent(render.id)}/publish`, {
        projectId: project.id,
        visibility: "unlisted",
      }),
    );
    if (result) setPublished((p) => ({ ...p, [render.id]: result.url }));
  }

  const publishedUrl = current ? (published[current.id] ?? current.publishedUrl) : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Videos"
        title={title}
        intro={
          <>
            <StatusBadge status={project.status} /> · {humanize(project.directorMode)} · v
            {project.currentVersion} · created {formatDate(project.createdAt)}
          </>
        }
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={renderFinal}
            disabled={renderAction.pending || jobActive || hasFinal}
            title={hasFinal ? "A final render already exists or is in progress" : undefined}
          >
            {renderAction.pending ? "Starting render…" : "Render final"}
          </button>
        }
      />
      {renderAction.error ? (
        <p className="form-error" role="alert">
          {renderAction.error}
        </p>
      ) : null}

      {job ? (
        <section className="panel job" aria-labelledby="job-title">
          <div className="panel-head">
            <h2 id="job-title" className="h4">
              {humanize(job.kind)} job
            </h2>
            <StatusBadge status={job.state} />
          </div>
          {ACTIVE_STATES.has(job.state) ? (
            <>
              <ProgressBar value={job.progress} label="Job progress" />
              <p className="muted small" aria-live="polite">
                {job.stage ? humanize(job.stage) : "Working"}
                {job.message ? `: ${job.message}` : ""}
              </p>
            </>
          ) : null}
          {job.state === "awaiting_host" ? (
            <p className="muted small">Waiting for the host model to answer a creative question over MCP.</p>
          ) : null}
          {job.error ? (
            <p className="form-error">
              {job.error.message} <code>{job.error.code}</code>
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="detail-grid">
        <section className="panel" aria-labelledby="player-title">
          <h2 id="player-title" className="visually-hidden">
            Player
          </h2>
          {current?.url ? (
            <>
              {/* biome-ignore lint/a11y/useMediaCaption: generated videos have no caption track yet. */}
              <video
                key={current.id}
                className="player"
                src={current.url}
                controls
                playsInline
                preload="metadata"
              />
              <div className="player-meta">
                <span>
                  {humanize(current.quality)} render · {formatDate(current.createdAt)}
                  {current.durationS ? ` · ${current.durationS.toFixed(1)} s` : ""}
                </span>
                <span className="inline-actions">
                  <a href={current.url} download>
                    Download
                  </a>
                  {publishedUrl ? (
                    <>
                      <a href={publishedUrl} target="_blank" rel="noreferrer">
                        Open share link
                      </a>
                      <CopyButton text={publishedUrl} label="Copy link" />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      onClick={() => publish(current)}
                      disabled={publishAction.pending}
                    >
                      {publishAction.pending ? "Publishing…" : "Publish"}
                    </button>
                  )}
                </span>
              </div>
              {publishAction.error ? (
                <p className="form-error" role="alert">
                  {publishAction.error}
                </p>
              ) : null}
            </>
          ) : (
            <EmptyState title={jobActive ? "Rendering…" : "No playable render yet"}>
              <p>
                {jobActive
                  ? "The player appears when the first render finishes."
                  : "Start a render to watch it here."}
              </p>
            </EmptyState>
          )}
          {detail.data.contactSheetUrl ? (
            <details className="disclosure">
              <summary>Contact sheet</summary>
              <img src={detail.data.contactSheetUrl} alt="Contact sheet of rendered frames" loading="lazy" />
            </details>
          ) : null}
        </section>

        <aside className="panel" aria-labelledby="renders-title">
          <h2 id="renders-title" className="h4">
            Renders
          </h2>
          {renders.length === 0 ? (
            <p className="muted small">No renders yet.</p>
          ) : (
            <ul className="item-list">
              {renders.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setSelectedRender(r.id)}
                    disabled={!r.url || r.status !== "succeeded"}
                    aria-pressed={current?.id === r.id}
                  >
                    {humanize(r.quality)}
                  </button>
                  <StatusBadge status={r.status} />
                  <span className="muted small">{formatDate(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}

          <h2 className="h4 aside-heading">Versions</h2>
          {versions.length === 0 ? (
            <p className="muted small">No versions yet.</p>
          ) : (
            <ul className="item-list">
              {[...versions]
                .sort((a, b) => b.version - a.version)
                .map((v) => (
                  <li key={v.version}>
                    <strong>v{v.version}</strong>
                    <span className="muted small">
                      {humanize(v.source)} · {formatDate(v.createdAt)}
                    </span>
                  </li>
                ))}
            </ul>
          )}

          {usage ? (
            <>
              <h2 className="h4 aside-heading">Usage</h2>
              <p>
                {formatCredits(usage.credits)}{" "}
                <span className="muted small">· {formatUsd(usage.costUsd)} cost</span>
              </p>
            </>
          ) : null}
        </aside>
      </div>

      <section className="panel" aria-labelledby="qa-title">
        <h2 id="qa-title" className="h3">
          QA issues
        </h2>
        {qaIssues.length === 0 ? (
          <p className="muted">No open QA issues.</p>
        ) : (
          <ul className="issue-list">
            {qaIssues.map((issue) => (
              <li key={issue.id} className={`issue issue-${issue.severity}`}>
                <span
                  className={`badge badge-${issue.severity === "error" ? "bad" : issue.severity === "warn" ? "busy" : "idle"}`}
                >
                  {humanize(issue.severity)}
                </span>
                <span>
                  {issue.message}
                  <span className="muted small">
                    {" "}
                    · {humanize(issue.category)} · {issue.source}
                    {issue.sceneId ? ` · scene ${issue.sceneId}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="scenes-title">
        <h2 id="scenes-title" className="h3">
          Scenes
        </h2>
        {scenes.length === 0 ? (
          <p className="muted">The Motion IR is not available yet.</p>
        ) : (
          <ol className="scene-list">
            {scenes.map((s, i) => (
              <li key={s.id}>
                <span className="scene-no">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <p className="h4">
                    {s.role ? humanize(s.role) : s.id}
                    {typeof s.duration === "number" ? (
                      <span className="muted small"> · {s.duration} s</span>
                    ) : null}
                  </p>
                  {s.intent ? <p>{s.intent}</p> : null}
                  {s.focalPoint ? <p className="muted small">Focal point: {s.focalPoint}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        {ir ? (
          <details className="disclosure">
            <summary>Motion IR JSON</summary>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable code must be keyboard reachable. */}
            <pre className="json" tabIndex={0}>
              <code>{JSON.stringify(ir, null, 2)}</code>
            </pre>
          </details>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="traces-title">
        <h2 id="traces-title" className="h3">
          Traces
        </h2>
        <TracePanel projectId={project.id} />
      </section>
    </>
  );
}
