import { type ReactNode, useEffect, useRef, useState } from "react";
import { humanize } from "../lib/format.ts";

export function PageHeader({
  title,
  eyebrow,
  intro,
  actions,
}: {
  title: string;
  eyebrow?: string;
  intro?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="page-title">{title}</h1>
        {intro ? <p className="page-intro">{intro}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p className="state state-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </p>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="h4">{title}</p>
      {children ? <div className="state-body">{children}</div> : null}
    </div>
  );
}

/** Renders loading / error / content for one `useApi` result; content only runs once data exists. */
export function Async<T>({
  state,
  label,
  children,
}: {
  state: { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void };
  label?: string;
  children: (data: T) => ReactNode;
}) {
  if (state.data !== undefined) return children(state.data);
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  return <Loading label={label} />;
}

const STATUS_TONE: Record<string, "ok" | "busy" | "bad" | "idle"> = {
  succeeded: "ok",
  ready: "ok",
  published: "ok",
  active: "ok",
  running: "busy",
  queued: "busy",
  awaiting_host: "busy",
  rendering: "busy",
  failed: "bad",
  error: "bad",
  revoked: "bad",
  cancelled: "idle",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "idle";
  return <span className={`badge badge-${tone}`}>{humanize(status)}</span>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [note, setNote] = useState("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied");
    } catch {
      setNote("Copy failed. Select the text and copy it manually.");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(""), 2500);
  }

  return (
    <span className="copy">
      <button type="button" className="copy-btn" onClick={copy}>
        {note === "Copied" ? "Copied" : label}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {note}
      </span>
    </span>
  );
}

export function CodeCard({ file, code, label }: { file: string; code: string; label: string }) {
  return (
    <figure className="code-card" aria-label={label}>
      <div className="code-bar">
        <span className="code-file">{file}</span>
        <CopyButton text={code} />
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable code must be keyboard reachable. */}
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="progress">
      <div
        className="progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-value">{pct}%</span>
    </div>
  );
}
