import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Async, CopyButton, PageHeader, StatusBadge } from "../components/ui.tsx";
import { errorMessage } from "../lib/api.ts";
import { api } from "../lib/client.ts";
import { formatDate } from "../lib/format.ts";
import type {
  MultixKey,
  PiLogin,
  PiLoginEvent,
  PiLoginPrompt,
  PiProvider,
  ProviderAuthType,
  ProvidersOverview,
} from "../lib/types.ts";
import { useAction, useApi, useDocumentTitle } from "../lib/use-api.ts";

const POLL_MS = 1500;
const ACTIVE = new Set<PiLogin["status"]>(["running", "waiting"]);

/** Only http(s) links from a provider are rendered as links. */
function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function connectionLabel(p: PiProvider): string {
  if (!p.connected) return "";
  const how = p.connected.authType === "oauth" ? (p.oauth?.name ?? "Sign-in") : "API key";
  return p.connected.hint ? `${how} ••••${p.connected.hint}` : how;
}

export function ProvidersPage() {
  useDocumentTitle("Model providers");
  const overview = useApi<ProvidersOverview>("/api/providers");

  return (
    <>
      <PageHeader
        title="Model providers"
        intro="Bring your own model accounts. Jobs in this workspace use them instead of the server's defaults. Keys are encrypted at rest and never shown again after you save them."
      />
      <Async state={overview} label="Loading providers">
        {(data) =>
          data.enabled ? (
            <>
              <PiSection data={data} reload={overview.reload} />
              <MultixSection keys={data.multix.keys} reload={overview.reload} />
            </>
          ) : (
            <p className="notice">
              Provider keys are not enabled on this server yet. The operator needs to set
              <code> CREDENTIALS_ENCRYPTION_KEY</code>; until then every job uses the server's own models.
            </p>
          )
        }
      </Async>
    </>
  );
}

// --- pi agent -----------------------------------------------------------------------------------

function PiSection({ data, reload }: { data: ProvidersOverview; reload: () => void }) {
  const [login, setLogin] = useState<PiLogin | undefined>(undefined);
  const [picked, setPicked] = useState("");
  const [justConnected, setJustConnected] = useState<string | undefined>(undefined);
  const startAction = useAction();
  const disconnectAction = useAction();
  const connected = data.pi.providers.filter((p) => p.connected);
  const pickedProvider = data.pi.providers.find((p) => p.id === picked);

  const finishLogin = useCallback(
    (status: PiLogin["status"], providerName: string) => {
      setLogin(undefined);
      if (status !== "succeeded") return;
      setJustConnected(providerName);
      setPicked("");
      reload();
    },
    [reload],
  );

  async function start(provider: string, type: ProviderAuthType) {
    setJustConnected(undefined);
    const result = await startAction.run(() =>
      api.post<{ login: PiLogin }>("/api/providers/pi/logins", { provider, type }),
    );
    if (result) setLogin(result.login);
  }

  async function disconnect(p: PiProvider) {
    if (!window.confirm(`Disconnect ${p.name}? Jobs that use its model go back to the server default.`))
      return;
    const ok = await disconnectAction.run(async () => {
      await api.del(`/api/providers/pi/${encodeURIComponent(p.id)}`);
      return true;
    });
    if (ok) reload();
  }

  return (
    <>
      <ModelChoice data={data} reload={reload} />

      <section className="panel" aria-labelledby="pi-title">
        <h2 id="pi-title" className="h3">
          Pi agent sign-ins
        </h2>
        <p className="muted">
          The pi agent builds each scene. Connect a provider with its own sign-in (a Claude, ChatGPT or
          Copilot subscription) or with an API key, the same two ways the pi CLI offers.
        </p>

        {connected.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Connected pi providers</caption>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Connected with</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {connected.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td>{connectionLabel(p)}</td>
                    <td className="nowrap">{p.connected ? formatDate(p.connected.updatedAt) : ""}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => disconnect(p)}
                        disabled={disconnectAction.pending}
                      >
                        Disconnect<span className="visually-hidden"> {p.name}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {disconnectAction.error ? (
          <p className="form-error" role="alert">
            {disconnectAction.error}
          </p>
        ) : null}

        <div className="form">
          <label className="field">
            <span className="field-label">
              {connected.length > 0 ? "Connect another provider" : "Connect a provider"}
            </span>
            <select value={picked} onChange={(e) => setPicked(e.target.value)} disabled={Boolean(login)}>
              <option value="">Choose a provider…</option>
              {data.pi.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.connected ? " (connected)" : ""}
                </option>
              ))}
            </select>
          </label>
          {pickedProvider ? (
            <div className="inline-actions">
              {pickedProvider.oauth ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => start(pickedProvider.id, "oauth")}
                  disabled={startAction.pending || Boolean(login)}
                >
                  {pickedProvider.oauth.loginLabel ?? `Sign in with ${pickedProvider.oauth.name}`}
                </button>
              ) : null}
              {pickedProvider.apiKey ? (
                <button
                  type="button"
                  className={pickedProvider.oauth ? "btn btn-quiet" : "btn btn-primary"}
                  onClick={() => start(pickedProvider.id, "api_key")}
                  disabled={startAction.pending || Boolean(login)}
                >
                  Add {pickedProvider.apiKey.name}
                </button>
              ) : null}
            </div>
          ) : null}
          {startAction.error ? (
            <p className="form-error" role="alert">
              {startAction.error}
            </p>
          ) : null}
        </div>

        {login ? (
          <LoginPanel
            initial={login}
            providerName={data.pi.providers.find((p) => p.id === login.provider)?.name ?? login.provider}
            onDone={finishLogin}
          />
        ) : null}
        {justConnected ? (
          <p className="notice" role="status">
            {justConnected} is connected. Choose one of its models under Scene model to use it for new jobs.
          </p>
        ) : null}
      </section>
    </>
  );
}

function ModelChoice({ data, reload }: { data: ProvidersOverview; reload: () => void }) {
  const providersWithModels = data.pi.providers.filter((p) => (data.pi.models[p.id]?.length ?? 0) > 0);
  const [pickedProvider, setProvider] = useState(data.pi.selected?.provider ?? "");
  const [model, setModel] = useState(data.pi.selected?.model ?? "");
  const save = useAction();
  // A provider disconnected since the last choice falls back to the first connected one.
  const provider = providersWithModels.some((p) => p.id === pickedProvider)
    ? pickedProvider
    : (providersWithModels[0]?.id ?? "");
  const models = data.pi.models[provider] ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !model) {
      save.setError("Choose a provider and a model.");
      return;
    }
    if (await save.run(() => api.put("/api/providers/pi/model", { provider, model }).then(() => true)))
      reload();
  }

  async function resetToDefault() {
    if (await save.run(() => api.put("/api/providers/pi/model", { provider: null }).then(() => true)))
      reload();
  }

  const current = data.pi.selected;
  return (
    <section className="panel panel-accent" aria-labelledby="model-title">
      <h2 id="model-title" className="h3">
        Scene model
      </h2>
      <p>
        {current ? (
          <>
            Jobs build scenes with <code>{current.model}</code> on{" "}
            {data.pi.providers.find((p) => p.id === current.provider)?.name ?? current.provider}.
          </>
        ) : (
          "Jobs build scenes with the server's default model."
        )}
      </p>
      {providersWithModels.length === 0 ? (
        <p className="muted small">Connect a provider below to choose one of its models.</p>
      ) : (
        <form className="form" onSubmit={submit}>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Provider</span>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel("");
                }}
              >
                {providersWithModels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Choose a model…</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="inline-actions">
            <button type="submit" className="btn btn-primary" disabled={save.pending}>
              {save.pending ? "Saving…" : "Use this model"}
            </button>
            {current ? (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={resetToDefault}
                disabled={save.pending}
              >
                Use the server default
              </button>
            ) : null}
          </div>
          {save.error ? (
            <p className="form-error" role="alert">
              {save.error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}

function EventLine({ event }: { event: PiLoginEvent }) {
  if (event.type === "auth_url") {
    const href = safeHref(event.url);
    return (
      <li>
        {href ? (
          <a className="btn btn-primary btn-sm" href={href} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
        ) : null}
        {event.instructions ? <span>{event.instructions}</span> : null}
      </li>
    );
  }
  if (event.type === "device_code") {
    const href = safeHref(event.verificationUri);
    return (
      <li>
        <span>
          Enter code <code>{event.userCode}</code> at{" "}
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {event.verificationUri}
            </a>
          ) : (
            event.verificationUri
          )}
        </span>
        <CopyButton text={event.userCode} label="Copy code" />
      </li>
    );
  }
  if (event.type === "info") {
    return (
      <li>
        <span>{event.message}</span>
        {event.links?.map((l) => {
          const href = safeHref(l.url);
          return href ? (
            <a key={l.url} href={href} target="_blank" rel="noopener noreferrer">
              {l.label ?? l.url}
            </a>
          ) : null;
        })}
      </li>
    );
  }
  return (
    <li className="muted">
      <span>{event.message}</span>
    </li>
  );
}

function PromptForm({
  prompt,
  onAnswer,
  pending,
}: {
  prompt: PiLoginPrompt;
  onAnswer: (v: string) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value) return;
    onAnswer(value);
    setValue("");
  }

  if (prompt.type === "select") {
    return (
      <form className="form" onSubmit={submit}>
        <fieldset className="choice">
          <legend className="field-label">{prompt.message}</legend>
          {prompt.options?.map((o) => (
            <label key={o.id} className="choice-option">
              <input
                type="radio"
                name={prompt.id}
                value={o.id}
                checked={value === o.id}
                onChange={() => setValue(o.id)}
              />
              <span>
                {o.label}
                {o.description ? <span className="muted small"> {o.description}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={pending || !value}>
          Continue
        </button>
      </form>
    );
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">{prompt.message}</span>
        <input
          type={prompt.type === "secret" ? "password" : "text"}
          value={value}
          placeholder={prompt.placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={pending || !value}>
        {prompt.type === "secret" ? "Save" : "Continue"}
      </button>
    </form>
  );
}

function LoginPanel({
  initial,
  providerName,
  onDone,
}: {
  initial: PiLogin;
  providerName: string;
  onDone: (status: PiLogin["status"], providerName: string) => void;
}) {
  const [login, setLogin] = useState(initial);
  const [error, setError] = useState<string | undefined>(undefined);
  const answer = useAction();
  const path = `/api/providers/pi/logins/${encodeURIComponent(initial.id)}`;

  useEffect(() => {
    if (login.status === "succeeded") {
      onDone("succeeded", providerName);
      return;
    }
    if (!ACTIVE.has(login.status)) return;
    const timer = window.setTimeout(() => {
      api
        .get<{ login: PiLogin }>(path)
        .then((r) => setLogin(r.login))
        .catch((err: unknown) => setError(errorMessage(err)));
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [login, path, onDone, providerName]);

  async function respond(value: string) {
    const promptId = login.prompt?.id;
    if (!promptId) return;
    const r = await answer.run(() => api.post<{ login: PiLogin }>(`${path}/respond`, { promptId, value }));
    if (r) setLogin(r.login);
  }

  async function cancel() {
    await api.del(path).catch(() => undefined);
    onDone("cancelled", providerName);
  }

  const active = ACTIVE.has(login.status);
  return (
    <section className="panel" aria-labelledby="login-title" aria-live="polite">
      <div className="panel-head">
        <h3 id="login-title" className="h4">
          {login.type === "oauth" ? "Signing in to" : "Adding a key for"} {providerName}
        </h3>
        <StatusBadge status={login.status === "waiting" ? "running" : login.status} />
      </div>
      {login.events.length > 0 ? (
        <ul className="item-list">
          {login.events.map((e, i) => (
            // Events only append, so the index is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
            <EventLine key={i} event={e} />
          ))}
        </ul>
      ) : null}
      {login.type === "oauth" && active ? (
        <p className="muted small">
          After you approve access, the provider may send you to a page on localhost that does not load. That
          is expected: copy that page's full address and paste it below.
        </p>
      ) : null}
      {login.prompt ? (
        <PromptForm key={login.prompt.id} prompt={login.prompt} onAnswer={respond} pending={answer.pending} />
      ) : null}
      {login.status === "succeeded" ? <p>{providerName} is connected.</p> : null}
      {login.status === "failed" ? (
        <p className="form-error" role="alert">
          {login.error ?? "Sign-in failed."}
        </p>
      ) : null}
      {answer.error || error ? (
        <p className="form-error" role="alert">
          {answer.error ?? error}
        </p>
      ) : null}
      <div className="inline-actions">
        {active ? (
          <button type="button" className="btn btn-quiet" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn-quiet" onClick={() => onDone(login.status, providerName)}>
            Close
          </button>
        )}
      </div>
    </section>
  );
}

// --- multix -------------------------------------------------------------------------------------

function MultixSection({ keys, reload }: { keys: MultixKey[]; reload: () => void }) {
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [value, setValue] = useState("");
  const save = useAction();
  const remove = useAction();

  async function submit(event: FormEvent<HTMLFormElement>, name: string) {
    event.preventDefault();
    if (!value.trim()) {
      save.setError("Paste the key first.");
      return;
    }
    const ok = await save.run(() =>
      api.put(`/api/providers/multix/${encodeURIComponent(name)}`, { value }).then(() => true),
    );
    if (ok) {
      setEditing(undefined);
      setValue("");
      reload();
    }
  }

  async function clear(name: string) {
    if (!window.confirm(`Remove ${name} from this workspace?`)) return;
    if (await remove.run(() => api.del(`/api/providers/multix/${encodeURIComponent(name)}`).then(() => true)))
      reload();
  }

  return (
    <section className="panel" aria-labelledby="multix-title">
      <h2 id="multix-title" className="h3">
        Media generation keys (multix)
      </h2>
      <p className="muted">
        The multix CLI generates images, video and audio. Each key below unlocks the providers listed next to
        it.
      </p>
      {remove.error ? (
        <p className="form-error" role="alert">
          {remove.error}
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">multix API keys</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Used by</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.name}>
                <th scope="row">
                  <code>{k.name}</code>
                </th>
                <td>{k.providers.join(", ")}</td>
                <td className="nowrap">
                  {k.set ? (
                    <span title={k.updatedAt ? `Updated ${formatDate(k.updatedAt)}` : undefined}>
                      <StatusBadge status="active" /> {k.hint ? <code>••••{k.hint}</code> : null}
                    </span>
                  ) : (
                    <span className="muted">Not set</span>
                  )}
                </td>
                <td className="num">
                  {editing === k.name ? (
                    <form className="inline-form" onSubmit={(e) => submit(e, k.name)}>
                      <label className="field">
                        <span className="visually-hidden">{k.name}</span>
                        <input
                          type="password"
                          value={value}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Paste key"
                          onChange={(e) => setValue(e.target.value)}
                        />
                      </label>
                      <button type="submit" className="btn btn-primary btn-sm" disabled={save.pending}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => {
                          setEditing(undefined);
                          setValue("");
                          save.setError(undefined);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => {
                          setEditing(k.name);
                          setValue("");
                        }}
                      >
                        {k.set ? "Replace" : "Set"}
                        <span className="visually-hidden"> {k.name}</span>
                      </button>
                      {k.set ? (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => clear(k.name)}
                          disabled={remove.pending}
                        >
                          Remove<span className="visually-hidden"> {k.name}</span>
                        </button>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {save.error ? (
        <p className="form-error" role="alert">
          {save.error}
        </p>
      ) : null}
    </section>
  );
}
