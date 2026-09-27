import { useState } from "react";
import { formatDate, formatMs, formatUsd } from "../lib/format.ts";
import type { Span, TraceDetail, TraceListItem } from "../lib/types.ts";
import { useApi } from "../lib/use-api.ts";
import { Async, EmptyState, StatusBadge } from "./ui.tsx";

/** Cost of one span without its children: model calls plus attributed render/asset/storage costs. */
export function spanOwnCost(span: Span): number {
  const models = (span.modelCalls ?? []).reduce((sum, call) => sum + (call.costUsd || 0), 0);
  const other = Object.values(span.costs ?? {}).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  return models + other;
}

/** Span cost including all descendants. */
export function spanTotalCost(span: Span): number {
  return spanOwnCost(span) + (span.children ?? []).reduce((sum, child) => sum + spanTotalCost(child), 0);
}

function SpanNode({ span }: { span: Span }) {
  const duration = span.endTime !== undefined ? span.endTime - span.startTime : undefined;
  const calls = span.modelCalls ?? [];
  return (
    <li>
      <div className={`span-row${span.status === "error" ? " span-error" : ""}`}>
        <code className="span-name">{span.name}</code>
        <span className="span-meta">
          {formatMs(duration)} · {formatUsd(spanTotalCost(span))}
          {calls.length > 0 ? ` · ${calls.map((c) => c.model).join(", ")}` : ""}
          {span.retries ? ` · ${span.retries} retries` : ""}
        </span>
        {span.error ? <span className="span-err-msg">{span.error}</span> : null}
      </div>
      {span.children && span.children.length > 0 ? (
        <ul>
          {span.children.map((child) => (
            <SpanNode key={child.spanId} span={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TraceTree({ traceId }: { traceId: string }) {
  const trace = useApi<TraceDetail>(`/api/traces/${encodeURIComponent(traceId)}`);
  return (
    <Async state={trace} label="Loading trace">
      {({ trace: data }) => {
        if (!data.root) return <EmptyState title="This trace has no spans." />;
        return (
          <>
            {data.summary ? (
              <p className="muted small">
                {formatMs(data.summary.durationMs)} total · {formatUsd(data.summary.cogsUsd)} cost of goods
                {data.summary.modelCalls !== undefined ? ` · ${data.summary.modelCalls} model calls` : ""}
                {data.summary.failures ? ` · ${data.summary.failures} failures` : ""}
              </p>
            ) : null}
            <ul className="span-tree" aria-label="Span tree">
              <SpanNode span={data.root} />
            </ul>
          </>
        );
      }}
    </Async>
  );
}

export function TracePanel({ projectId }: { projectId: string }) {
  const traces = useApi<{ traces: TraceListItem[] }>(`/api/projects/${encodeURIComponent(projectId)}/traces`);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  return (
    <Async state={traces} label="Loading traces">
      {(data) =>
        data.traces.length === 0 ? (
          <EmptyState title="No traces yet">
            <p>Traces appear once a job starts running.</p>
          </EmptyState>
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Job traces</caption>
                <thead>
                  <tr>
                    <th scope="col">Trace</th>
                    <th scope="col">Result</th>
                    <th scope="col">Started</th>
                    <th scope="col" className="num">
                      Latency
                    </th>
                    <th scope="col" className="num">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.traces.map((t) => (
                    <tr key={t.id} aria-current={selected === t.id ? "true" : undefined}>
                      <th scope="row">
                        <button
                          type="button"
                          className="link-button"
                          aria-expanded={selected === t.id}
                          onClick={() => setSelected(selected === t.id ? undefined : t.id)}
                        >
                          {t.name ?? t.jobId ?? t.id}
                        </button>
                      </th>
                      <td>
                        {t.summary ? (
                          <StatusBadge status={t.summary.failures ? "failed" : "succeeded"} />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="nowrap">{formatDate(t.createdAt)}</td>
                      <td className="num">{formatMs(t.summary?.durationMs)}</td>
                      <td className="num">{formatUsd(t.summary?.cogsUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selected ? <TraceTree key={selected} traceId={selected} /> : null}
          </>
        )
      }
    </Async>
  );
}
