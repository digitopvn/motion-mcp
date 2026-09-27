import type { UsageEvent } from "./types.ts";

export interface UsageRow {
  date: string;
  operation: string;
  count: number;
  quantity: number;
  credits: number;
}

/** Local calendar day (YYYY-MM-DD) of an ISO timestamp, or null when it does not parse. */
export function dayOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Groups usage events by day and operation, newest day first, operations alphabetical within a day. */
export function summarizeUsage(events: UsageEvent[]): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const e of events) {
    const date = dayOf(e.createdAt);
    if (!date) continue;
    const key = `${date}\u0000${e.operation}`;
    const row = rows.get(key) ?? { date, operation: e.operation, count: 0, quantity: 0, credits: 0 };
    row.count += 1;
    row.quantity += e.quantity ?? 1;
    row.credits += e.credits || 0;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) =>
    a.date === b.date ? a.operation.localeCompare(b.operation) : b.date.localeCompare(a.date),
  );
}

/** ISO timestamp `days` days before `now`, used for the `since` query parameter. */
export function sinceDays(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
