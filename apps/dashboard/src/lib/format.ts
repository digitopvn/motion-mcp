import type { Billing, DirectorMode, Price, Quality } from "./types.ts";

/** 1 credit = $0.01, matching `CREDIT_USD` in packages/billing/src/prices.ts. */
export const CREDIT_USD = 0.01;

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const preciseUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatCredits(credits: number | null | undefined): string {
  if (credits === null || credits === undefined || !Number.isFinite(credits)) return "—";
  const n = integer.format(credits);
  return Math.abs(credits) === 1 ? `${n} credit` : `${n} credits`;
}

export function creditsToUsd(credits: number): string {
  return usd.format(Math.round(credits * CREDIT_USD * 100) / 100);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value !== 0 && Math.abs(value) < 0.01 ? preciseUsd.format(value) : usd.format(value);
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

/**
 * Accepts the prices either as an array of rows or as the `CREDIT_PRICES` record keyed by operation, and
 * returns a sorted array. Rows without a finite credit amount are dropped.
 */
export function normalizePrices(prices: Billing["prices"] | null | undefined): Price[] {
  if (!prices) return [];
  const rows: Price[] = Array.isArray(prices)
    ? prices
    : Object.entries(prices).map(([operation, p]) => ({ operation, credits: p.credits, unit: p.unit }));
  return rows
    .filter((p) => typeof p.operation === "string" && Number.isFinite(p.credits))
    .sort((a, b) => a.operation.localeCompare(b.operation));
}

export interface EstimateInput {
  directorMode: DirectorMode;
  quality: Quality;
  durationSeconds: number;
}

export interface EstimateLine {
  label: string;
  credits: number;
}

export interface Estimate {
  lines: EstimateLine[];
  total: number;
}

/**
 * Indicative credit cost of a new video, built from the live price list:
 * orchestration per job, the internal Opus director when the server directs, and either a draft preview
 * or HD render minutes for a final render. Returns null when a required price is missing.
 */
export function estimateVideoCost(input: EstimateInput, prices: Price[]): Estimate | null {
  const byOp = new Map(prices.map((p) => [p.operation, p.credits]));
  const price = (op: string): number | undefined => byOp.get(op);

  const orchestration = price("orchestration_job");
  const direction = price("creative_direction");
  const render = input.quality === "final" ? price("render_minute_hd") : price("preview_render");
  if (orchestration === undefined || render === undefined) return null;
  if (input.directorMode === "internal-opus" && direction === undefined) return null;

  const lines: EstimateLine[] = [{ label: "Orchestration", credits: orchestration }];
  if (input.directorMode === "internal-opus" && direction !== undefined) {
    lines.push({ label: "Creative direction (Opus)", credits: direction });
  }
  if (input.quality === "final") {
    const minutes = Math.max(0, input.durationSeconds) / 60;
    lines.push({ label: "Final render (HD)", credits: Math.ceil(minutes * render - 1e-9) });
  } else {
    lines.push({ label: "Preview render", credits: render });
  }
  return { lines, total: lines.reduce((sum, l) => sum + l.credits, 0) };
}

export function formatEstimate(estimate: Estimate | null): string {
  if (!estimate) return "Estimate unavailable";
  return `≈ ${formatCredits(estimate.total)} (${creditsToUsd(estimate.total)})`;
}

export function humanize(value: string): string {
  const spaced = value.replaceAll(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
