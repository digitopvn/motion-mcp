import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageHeader } from "../components/ui.tsx";
import { api } from "../lib/client.ts";
import { estimateVideoCost, formatCredits, formatEstimate, normalizePrices } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";
import type {
  AspectRatio,
  Billing,
  CreateProjectInput,
  CreateProjectOutput,
  DirectorMode,
  Quality,
  Recipe,
} from "../lib/types.ts";
import { useAction, useApi, useDocumentTitle } from "../lib/use-api.ts";

const ASPECT_RATIOS: { value: AspectRatio; label: string }[] = [
  { value: "16:9", label: "16:9 landscape" },
  { value: "9:16", label: "9:16 vertical" },
  { value: "1:1", label: "1:1 square" },
  { value: "4:5", label: "4:5 portrait" },
];

/** host-opus needs a creativeSpec from the host model, so it is only available through MCP clients. */
const DIRECTOR_MODES: { value: DirectorMode; label: string; hint: string }[] = [
  {
    value: "internal-opus",
    label: "Internal Opus",
    hint: "The server's creative director writes the direction. Recommended.",
  },
  { value: "custom", label: "Custom", hint: "Uses the workspace's custom director configuration." },
];

const MIN_BRIEF = 3;
const MAX_BRIEF = 8000;

interface FormState {
  brief: string;
  directorMode: DirectorMode;
  duration: string;
  aspectRatio: AspectRatio;
  quality: Quality;
  recipeId: string;
}

const DEFAULTS: FormState = {
  brief: "",
  directorMode: "internal-opus",
  duration: "15",
  aspectRatio: "16:9",
  quality: "preview",
  recipeId: "",
};

function fromRecipe(recipe: Recipe): FormState {
  return {
    brief: recipe.brief,
    directorMode: recipe.directorMode === "custom" ? "custom" : "internal-opus",
    duration: recipe.durationSeconds ? String(recipe.durationSeconds) : DEFAULTS.duration,
    aspectRatio: recipe.format?.aspectRatio ?? DEFAULTS.aspectRatio,
    quality: recipe.quality ?? DEFAULTS.quality,
    recipeId: recipe.id,
  };
}

function validateCreate(form: FormState): { input?: CreateProjectInput; error?: string } {
  const brief = form.brief.trim();
  if (brief.length < MIN_BRIEF) return { error: "Write a brief of at least a few words." };
  if (brief.length > MAX_BRIEF) return { error: `Keep the brief under ${MAX_BRIEF} characters.` };
  const duration = Number(form.duration);
  if (!Number.isFinite(duration) || duration < 3 || duration > 180) {
    return { error: "Duration must be between 3 and 180 seconds." };
  }
  return {
    input: {
      brief,
      directorMode: form.directorMode,
      durationSeconds: duration,
      format: { aspectRatio: form.aspectRatio },
      quality: form.quality,
    },
  };
}

export function VideoNewPage() {
  useDocumentTitle("New video");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { me, refresh } = useSession();
  const recipes = useApi<{ recipes: Recipe[] }>("/api/recipes");
  const billing = useApi<Billing>("/api/billing");
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [prefilled, setPrefilled] = useState(false);
  const submit = useAction();

  // Prefill once from ?recipe=<id> after recipes load.
  const recipeParam = params.get("recipe");
  useEffect(() => {
    if (prefilled || !recipeParam || !recipes.data) return;
    const recipe = recipes.data.recipes.find((r) => r.id === recipeParam);
    if (recipe) setForm(fromRecipe(recipe));
    setPrefilled(true);
  }, [prefilled, recipeParam, recipes.data]);

  const prices = useMemo(() => normalizePrices(billing.data?.prices), [billing.data]);
  const estimate = useMemo(
    () =>
      estimateVideoCost(
        {
          directorMode: form.directorMode,
          quality: form.quality,
          durationSeconds: Number(form.duration) || 0,
        },
        prices,
      ),
    [form.directorMode, form.quality, form.duration, prices],
  );

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function applyRecipe(id: string) {
    const recipe = recipes.data?.recipes.find((r) => r.id === id);
    setForm(recipe ? fromRecipe(recipe) : { ...form, recipeId: "" });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { input, error } = validateCreate(form);
    if (!input) {
      submit.setError(error);
      return;
    }
    // Saved recipes only prefill the form; motion_create's `recipeId` refers to domain-pack recipes.
    const created = await submit.run(() => api.post<CreateProjectOutput>("/api/projects", input));
    if (created) {
      refresh();
      navigate(`/videos/${encodeURIComponent(created.projectId)}`);
    }
  }

  const briefLength = form.brief.trim().length;
  const recipeList = recipes.data?.recipes ?? [];
  const mode = DIRECTOR_MODES.find((m) => m.value === form.directorMode);
  const overBudget = estimate !== null && estimate.total > me.credits.balance;

  return (
    <>
      <PageHeader
        eyebrow="Videos"
        title="New video"
        intro="Describe what the video should say, for whom, and how it should feel."
      />
      <form className="form" onSubmit={onSubmit} noValidate>
        {recipeList.length > 0 ? (
          <label className="field">
            <span className="field-label">Start from a recipe</span>
            <select value={form.recipeId} onChange={(e) => applyRecipe(e.target.value)}>
              <option value="">No recipe</option>
              {recipeList.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field">
          <span className="field-label">Brief</span>
          <textarea
            name="brief"
            rows={8}
            required
            minLength={MIN_BRIEF}
            maxLength={MAX_BRIEF}
            value={form.brief}
            onChange={(e) => update("brief", e.target.value)}
            aria-describedby="brief-hint"
            placeholder="A 20-second launch teaser for a developer tool. Calm, precise, confident. End on the logo and the URL."
          />
          <span id="brief-hint" className="field-hint">
            {briefLength} / {MAX_BRIEF} characters
          </span>
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Director mode</span>
            <select
              value={form.directorMode}
              onChange={(e) => update("directorMode", e.target.value as DirectorMode)}
              aria-describedby="mode-hint"
            >
              {DIRECTOR_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span id="mode-hint" className="field-hint">
              {mode?.hint} Host-directed mode is available from MCP clients.
            </span>
          </label>

          <label className="field">
            <span className="field-label">Duration (seconds)</span>
            <input
              type="number"
              inputMode="numeric"
              min={3}
              max={180}
              step={1}
              value={form.duration}
              onChange={(e) => update("duration", e.target.value)}
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Format</span>
            <select
              value={form.aspectRatio}
              onChange={(e) => update("aspectRatio", e.target.value as AspectRatio)}
            >
              {ASPECT_RATIOS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="field choice">
            <legend className="field-label">Quality</legend>
            {(["preview", "final"] as const).map((q) => (
              <label key={q} className="choice-option">
                <input
                  type="radio"
                  name="quality"
                  value={q}
                  checked={form.quality === q}
                  onChange={() => update("quality", q)}
                />
                {q === "preview" ? "Preview (draft)" : "Final (HD)"}
              </label>
            ))}
          </fieldset>
        </div>

        <div className="estimate" aria-live="polite">
          <p className="estimate-total">
            <span className="stat-label">Estimated cost</span>
            <span className="estimate-value">
              {billing.error
                ? "Prices unavailable"
                : billing.data
                  ? formatEstimate(estimate)
                  : "Loading prices…"}
            </span>
          </p>
          {estimate ? (
            <ul className="estimate-lines">
              {estimate.lines.map((line) => (
                <li key={line.label}>
                  <span>{line.label}</span>
                  <span className="num">{formatCredits(line.credits)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="field-hint">
            Indicative only; retries, critique passes and generated assets are billed as used. Balance:{" "}
            {formatCredits(me.credits.balance)}.
          </p>
          {overBudget ? (
            <p className="form-error">
              This may exceed your balance. <Link to="/billing">Buy credits</Link>
            </p>
          ) : null}
        </div>

        {submit.error ? (
          <p className="form-error" role="alert">
            {submit.error}
          </p>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={submit.pending}>
            {submit.pending ? "Starting…" : "Create video"}
          </button>
          <Link className="btn btn-quiet" to="/videos">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
