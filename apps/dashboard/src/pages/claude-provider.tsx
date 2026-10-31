import { type FormEvent, useState } from "react";
import { Async, StatusBadge } from "../components/ui.tsx";
import { api } from "../lib/client.ts";
import { formatDate } from "../lib/format.ts";
import type { ClaudeOverview, ClaudeSettings } from "../lib/types.ts";
import { useAction, useApi } from "../lib/use-api.ts";

const STATUS_TEXT: Record<ClaudeOverview["status"], string> = {
  unconfigured: "No API key saved. Every role uses the server's defaults.",
  connecting: "Connecting…",
  connected: "Connected with your Anthropic API key.",
  expired: "The connection expired. Save the key again.",
  revoked: "Anthropic rejected the saved key. Jobs pinned to it stop until you replace it.",
  unavailable: "Unavailable on this server.",
  blocked_by_policy: "Unavailable for hosted service.",
};

/** Anthropic API key (BYOK) and which roles run on it. Subscription sign-in is shown as blocked by policy. */
export function ClaudeSection() {
  const overview = useApi<ClaudeOverview>("/api/providers/claude");
  return (
    <Async state={overview} label="Loading Claude">
      {(data) => <ClaudePanel data={data} reload={overview.reload} />}
    </Async>
  );
}

function ClaudePanel({ data, reload }: { data: ClaudeOverview; reload: () => void }) {
  const [key, setKey] = useState("");
  const save = useAction();
  const test = useAction();
  const remove = useAction();
  const [tested, setTested] = useState<string | undefined>(undefined);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!key.trim()) {
      save.setError("Paste the key first.");
      return;
    }
    setTested(undefined);
    if (await save.run(() => api.put("/api/providers/claude/api-key", { apiKey: key }).then(() => true))) {
      setKey("");
      reload();
    }
  }

  async function runTest() {
    setTested(undefined);
    const result = await test.run(() =>
      api.post<{ keyState: NonNullable<ClaudeOverview["keyState"]> }>("/api/providers/claude/test", {}),
    );
    if (!result) return;
    setTested(
      result.keyState.status === "valid" ? "Anthropic accepted the key." : "Anthropic rejected the key.",
    );
    reload();
  }

  async function clear() {
    if (!window.confirm("Remove the Anthropic API key? Roles set to Claude stop until you add a key again."))
      return;
    setTested(undefined);
    if (await remove.run(() => api.del("/api/providers/claude/api-key").then(() => true))) reload();
  }

  return (
    <section className="panel" aria-labelledby="claude-title">
      <h2 id="claude-title" className="h3">
        Claude (Anthropic API)
      </h2>
      <p className="muted">
        Run the creative director, the critic or the scene builder on your own Anthropic API key. Anthropic
        bills your key directly, so director and critic calls made with it cost no credits; orchestration and
        rendering still do. Token costs shown in job traces are estimates.
      </p>
      <p aria-live="polite">
        <StatusBadge status={data.status} /> {STATUS_TEXT[data.status]}
        {data.apiKey?.hint ? (
          <>
            {" "}
            <code>••••{data.apiKey.hint}</code>
            <span className="muted small"> (updated {formatDate(data.apiKey.updatedAt)})</span>
          </>
        ) : null}
      </p>
      {data.keyState?.message && data.status === "revoked" ? (
        <p className="form-error">{data.keyState.message}</p>
      ) : null}

      {data.enabled ? (
        <>
          <form className="inline-form" onSubmit={submit}>
            <label className="field">
              <span className="field-label">{data.apiKey ? "Replace API key" : "Anthropic API key"}</span>
              <input
                type="password"
                value={key}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-api03-…"
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={save.pending}>
              {save.pending ? "Checking…" : "Save key"}
            </button>
            {data.apiKey ? (
              <>
                <button type="button" className="btn btn-quiet" onClick={runTest} disabled={test.pending}>
                  {test.pending ? "Testing…" : "Test"}
                </button>
                <button type="button" className="btn btn-danger" onClick={clear} disabled={remove.pending}>
                  Remove
                </button>
              </>
            ) : null}
          </form>
          {[save.error, test.error, remove.error].filter(Boolean).map((message) => (
            <p key={message} className="form-error" role="alert">
              {message}
            </p>
          ))}
          {tested ? (
            <p className="muted small" role="status">
              {tested}
            </p>
          ) : null}
          <RoleSettings data={data} reload={reload} />
        </>
      ) : null}

      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">Claude sign-in methods</caption>
          <tbody>
            <tr>
              <th scope="row">Anthropic API key</th>
              <td>
                <StatusBadge status={data.status} />
              </td>
            </tr>
            <tr>
              <th scope="row">Claude subscription (Pro/Max)</th>
              <td>
                <StatusBadge status={data.subscription.status} />{" "}
                <span className="muted small">
                  Unavailable for hosted service. {data.subscription.reason}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RoleSettings({ data, reload }: { data: ClaudeOverview; reload: () => void }) {
  const [form, setForm] = useState<ClaudeSettings>(data.settings);
  const save = useAction();
  const set = <K extends keyof ClaudeSettings>(field: K, value: ClaudeSettings[K]) =>
    setForm((f) => ({ ...f, [field]: value }));
  const noKey = !data.apiKey;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await save.run(() => api.put("/api/providers/claude/settings", form).then(() => true))) reload();
  }

  const modelSelect = (field: "directorModel" | "criticModel" | "workerModel", label: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={form[field]} onChange={(e) => set(field, e.target.value)}>
        {data.models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form className="form" onSubmit={submit} aria-labelledby="claude-roles-title">
      <h3 id="claude-roles-title" className="h4">
        Roles
      </h3>
      {noKey ? <p className="muted small">Save an API key to move a role to Claude.</p> : null}
      <div className="field-row">
        <label className="field">
          <span className="field-label">Creative director</span>
          <select
            value={form.director}
            onChange={(e) => set("director", e.target.value as ClaudeSettings["director"])}
          >
            <option value="openrouter">Server default (OpenRouter)</option>
            <option value="anthropic-api">Claude on my API key</option>
          </select>
        </label>
        {modelSelect("directorModel", "Director model")}
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Critic</span>
          <select
            value={form.critic}
            onChange={(e) => set("critic", e.target.value as ClaudeSettings["critic"])}
          >
            <option value="openrouter">Server default (OpenRouter)</option>
            <option value="anthropic-api">Claude on my API key</option>
          </select>
        </label>
        {modelSelect("criticModel", "Critic model")}
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Scene builder</span>
          <select
            value={form.sceneWorker}
            onChange={(e) => set("sceneWorker", e.target.value as ClaudeSettings["sceneWorker"])}
          >
            <option value="pi">Pi agent</option>
            <option
              value="claude-agent-sdk"
              disabled={!data.worker.available && form.sceneWorker !== "claude-agent-sdk"}
            >
              Claude Agent SDK{data.worker.available ? "" : " (unavailable)"}
            </option>
          </select>
        </label>
        {modelSelect("workerModel", "Scene model")}
      </div>
      {!data.worker.available && data.worker.reason ? (
        <p className="muted small">Claude scene builder: {data.worker.reason}</p>
      ) : null}
      <fieldset className="choice">
        <legend className="field-label">If the key stops working</legend>
        <label className="choice-option">
          <input
            type="radio"
            name="claude-fallback"
            checked={form.fallback === "none"}
            onChange={() => set("fallback", "none")}
          />
          Stop the job (never spend server credits instead)
        </label>
        <label className="choice-option">
          <input
            type="radio"
            name="claude-fallback"
            checked={form.fallback === "server"}
            onChange={() => set("fallback", "server")}
          />
          Use the server default and charge credits
        </label>
      </fieldset>
      <div className="inline-actions">
        <button type="submit" className="btn btn-primary" disabled={save.pending}>
          {save.pending ? "Saving…" : "Save roles"}
        </button>
      </div>
      {save.error ? (
        <p className="form-error" role="alert">
          {save.error}
        </p>
      ) : null}
    </form>
  );
}
