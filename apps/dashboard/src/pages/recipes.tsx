import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { Async, EmptyState, PageHeader } from "../components/ui.tsx";
import { api } from "../lib/client.ts";
import { formatDate, humanize } from "../lib/format.ts";
import type { AspectRatio, DirectorMode, Quality, Recipe, RecipeFormat, RecipeInput } from "../lib/types.ts";
import { useAction, useApi, useDocumentTitle } from "../lib/use-api.ts";

interface Draft {
  name: string;
  brief: string;
  directorMode: DirectorMode;
  aspectRatio: AspectRatio;
  /** Width/height/fps set through the API are kept as-is; the form only edits the aspect ratio. */
  baseFormat: RecipeFormat;
  duration: string;
  quality: Quality;
  notes: string;
}

const EMPTY: Draft = {
  name: "",
  brief: "",
  directorMode: "internal-opus",
  aspectRatio: "16:9",
  baseFormat: {},
  duration: "15",
  quality: "preview",
  notes: "",
};

interface RecipeResponse {
  recipe: Recipe;
}

function toDraft(r: Recipe): Draft {
  return {
    name: r.name,
    brief: r.brief,
    directorMode: r.directorMode ?? EMPTY.directorMode,
    aspectRatio: r.format?.aspectRatio ?? EMPTY.aspectRatio,
    baseFormat: r.format ?? {},
    duration: r.durationSeconds ? String(r.durationSeconds) : EMPTY.duration,
    quality: r.quality ?? EMPTY.quality,
    notes: r.notes ?? "",
  };
}

function toInput(d: Draft): { input?: RecipeInput; error?: string } {
  const name = d.name.trim();
  const brief = d.brief.trim();
  if (!name) return { error: "Give the recipe a name." };
  if (name.length > 120) return { error: "Keep the name under 120 characters." };
  if (brief.length < 3) return { error: "Write a brief of at least a few words." };
  if (brief.length > 8000) return { error: "Keep the brief under 8000 characters." };
  const duration = Number(d.duration);
  if (!Number.isFinite(duration) || duration < 3 || duration > 180) {
    return { error: "Duration must be between 3 and 180 seconds." };
  }
  return {
    input: {
      name,
      brief,
      directorMode: d.directorMode,
      format: { ...d.baseFormat, aspectRatio: d.aspectRatio },
      durationSeconds: duration,
      quality: d.quality,
      notes: d.notes.trim() || null,
    },
  };
}

function RecipeForm({
  initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSave: (input: RecipeInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { input, error: invalid } = toInput(draft);
    if (!input) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(undefined);
    const ok = await onSave(input);
    setSaving(false);
    if (!ok) setError("Saving failed. Check the message above and retry.");
  }

  return (
    <form className="form panel" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field-label">Name</span>
        <input value={draft.name} maxLength={120} onChange={(e) => set("name", e.target.value)} required />
      </label>
      <label className="field">
        <span className="field-label">Brief</span>
        <textarea
          rows={6}
          value={draft.brief}
          maxLength={8000}
          onChange={(e) => set("brief", e.target.value)}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Director mode</span>
          <select
            value={draft.directorMode}
            onChange={(e) => set("directorMode", e.target.value as DirectorMode)}
          >
            <option value="internal-opus">Internal Opus</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Format</span>
          <select
            value={draft.aspectRatio}
            onChange={(e) => set("aspectRatio", e.target.value as AspectRatio)}
          >
            <option value="16:9">16:9 landscape</option>
            <option value="9:16">9:16 vertical</option>
            <option value="1:1">1:1 square</option>
            <option value="4:5">4:5 portrait</option>
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Duration (seconds)</span>
          <input
            type="number"
            inputMode="numeric"
            min={3}
            max={180}
            value={draft.duration}
            onChange={(e) => set("duration", e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Quality</span>
          <select value={draft.quality} onChange={(e) => set("quality", e.target.value as Quality)}>
            <option value="preview">Preview (draft)</option>
            <option value="final">Final (HD)</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Notes (optional)</span>
        <textarea
          rows={3}
          value={draft.notes}
          maxLength={2000}
          onChange={(e) => set("notes", e.target.value)}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RecipesPage() {
  useDocumentTitle("Recipes");
  const recipes = useApi<{ recipes: Recipe[] }>("/api/recipes");
  const [editing, setEditing] = useState<string | "new" | undefined>(undefined);
  const action = useAction();

  async function create(input: RecipeInput): Promise<boolean> {
    // `null` only means "clear" on PATCH; a new recipe simply omits empty notes.
    const body: RecipeInput = input.notes === null ? { ...input, notes: undefined } : input;
    const created = await action.run(
      async () => (await api.post<RecipeResponse>("/api/recipes", body)).recipe,
    );
    if (!created) return false;
    recipes.setData((d) => ({ recipes: [created, ...(d?.recipes ?? [])] }));
    setEditing(undefined);
    return true;
  }

  async function update(id: string, input: RecipeInput): Promise<boolean> {
    const saved = await action.run(
      async () => (await api.patch<RecipeResponse>(`/api/recipes/${encodeURIComponent(id)}`, input)).recipe,
    );
    if (!saved) return false;
    recipes.setData((d) => ({ recipes: (d?.recipes ?? []).map((r) => (r.id === id ? saved : r)) }));
    setEditing(undefined);
    return true;
  }

  async function remove(recipe: Recipe) {
    if (!window.confirm(`Delete the recipe “${recipe.name}”? This cannot be undone.`)) return;
    const done = await action.run(async () => {
      await api.del(`/api/recipes/${encodeURIComponent(recipe.id)}`);
      return true;
    });
    if (done) recipes.setData((d) => ({ recipes: (d?.recipes ?? []).filter((r) => r.id !== recipe.id) }));
  }

  return (
    <>
      <PageHeader
        title="Recipes"
        intro="Saved briefs and settings you reuse. Start a new video from any recipe."
        actions={
          editing === "new" ? null : (
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
              New recipe
            </button>
          )
        }
      />
      {action.error ? (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      ) : null}
      {editing === "new" ? (
        <RecipeForm
          initial={EMPTY}
          submitLabel="Save recipe"
          onSave={create}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}

      <Async state={recipes} label="Loading recipes">
        {(data) =>
          data.recipes.length === 0 ? (
            editing === "new" ? null : (
              <EmptyState title="No recipes yet">
                <p>Save a brief you use often, with its format and director settings.</p>
              </EmptyState>
            )
          ) : (
            <ul className="card-list">
              {data.recipes.map((r) =>
                editing === r.id ? (
                  <li key={r.id}>
                    <RecipeForm
                      initial={toDraft(r)}
                      submitLabel="Save changes"
                      onSave={(input) => update(r.id, input)}
                      onCancel={() => setEditing(undefined)}
                    />
                  </li>
                ) : (
                  <li key={r.id} className="card">
                    <div className="card-head">
                      <h2 className="h4">{r.name}</h2>
                      <p className="muted small">
                        {[
                          r.directorMode ? humanize(r.directorMode) : null,
                          r.format?.aspectRatio,
                          r.durationSeconds ? `${r.durationSeconds} s` : null,
                          r.quality ? humanize(r.quality) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <p className="card-body clamp">{r.brief}</p>
                    {r.notes ? <p className="muted small">{r.notes}</p> : null}
                    <div className="card-actions">
                      <Link
                        className="btn btn-primary btn-sm"
                        to={`/videos/new?recipe=${encodeURIComponent(r.id)}`}
                      >
                        Use recipe
                      </Link>
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(r.id)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => remove(r)}
                        disabled={action.pending}
                      >
                        Delete
                      </button>
                      {r.updatedAt ? (
                        <span className="muted small">Updated {formatDate(r.updatedAt, false)}</span>
                      ) : null}
                    </div>
                  </li>
                ),
              )}
            </ul>
          )
        }
      </Async>
    </>
  );
}
