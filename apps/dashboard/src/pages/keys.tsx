import { type FormEvent, useState } from "react";
import { Async, CopyButton, EmptyState, PageHeader, StatusBadge } from "../components/ui.tsx";
import { api } from "../lib/client.ts";
import { formatDate } from "../lib/format.ts";
import type { ApiKey, CreatedApiKey } from "../lib/types.ts";
import { useAction, useApi, useDocumentTitle } from "../lib/use-api.ts";

export function KeysPage() {
  useDocumentTitle("API keys");
  const keys = useApi<{ keys: ApiKey[] }>("/api/keys");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedApiKey | undefined>(undefined);
  const createAction = useAction();
  const revokeAction = useAction();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = name.trim();
    if (!label) {
      createAction.setError("Name the key after the client that will use it, e.g. “Claude Desktop”.");
      return;
    }
    const result = await createAction.run(() => api.post<CreatedApiKey>("/api/keys", { name: label }));
    if (result) {
      setCreated(result);
      setName("");
      keys.setData((d) => ({ keys: [result.key, ...(d?.keys ?? [])] }));
    }
  }

  async function revoke(key: ApiKey) {
    if (!window.confirm(`Revoke “${key.name}”? Clients using it will stop working immediately.`)) return;
    const ok = await revokeAction.run(async () => {
      await api.del(`/api/keys/${encodeURIComponent(key.id)}`);
      return true;
    });
    if (ok) {
      const revokedAt = new Date().toISOString();
      keys.setData((d) => ({
        keys: (d?.keys ?? []).map((k) => (k.id === key.id ? { ...k, revokedAt } : k)),
      }));
    }
  }

  return (
    <>
      <PageHeader
        title="API keys"
        intro="Keys authenticate MCP clients against this workspace. Send one as a bearer token to /mcp."
      />

      {created ? (
        <section className="panel panel-accent" aria-labelledby="new-key-title">
          <h2 id="new-key-title" className="h4">
            Copy your new key now
          </h2>
          <p>
            This is the only time the full key is shown. Store it in your MCP client or a secret manager; if
            you lose it, revoke it and create another.
          </p>
          <div className="secret">
            <code className="secret-value">{created.secret}</code>
            <CopyButton text={created.secret} label="Copy key" />
          </div>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setCreated(undefined)}>
            I have stored it
          </button>
        </section>
      ) : null}

      <form className="inline-form" onSubmit={create}>
        <label className="field">
          <span className="field-label">New key name</span>
          <input
            value={name}
            maxLength={80}
            placeholder="Claude Desktop"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={createAction.pending}>
          {createAction.pending ? "Creating…" : "Create key"}
        </button>
      </form>
      {createAction.error ? (
        <p className="form-error" role="alert">
          {createAction.error}
        </p>
      ) : null}
      {revokeAction.error ? (
        <p className="form-error" role="alert">
          {revokeAction.error}
        </p>
      ) : null}

      <Async state={keys} label="Loading keys">
        {(data) =>
          data.keys.length === 0 ? (
            <EmptyState title="No API keys yet">
              <p>Create one to connect Claude, ChatGPT, Pi or any MCP client.</p>
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">API keys</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Key</th>
                    <th scope="col">Created</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.keys.map((k) => (
                    <tr key={k.id}>
                      <th scope="row">{k.name}</th>
                      <td>
                        <code>{k.prefix}…</code>
                      </td>
                      <td className="nowrap">{formatDate(k.createdAt)}</td>
                      <td>
                        {k.revokedAt ? (
                          <span title={`Revoked ${formatDate(k.revokedAt)}`}>
                            <StatusBadge status="revoked" />
                          </span>
                        ) : (
                          <StatusBadge status="active" />
                        )}
                      </td>
                      <td className="num">
                        {k.revokedAt ? null : (
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => revoke(k)}
                            disabled={revokeAction.pending}
                          >
                            Revoke<span className="visually-hidden"> {k.name}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
    </>
  );
}
