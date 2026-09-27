import { useMemo, useState } from "react";
import { Async, EmptyState, ErrorState, Loading, PageHeader } from "../components/ui.tsx";
import { api } from "../lib/client.ts";
import { creditsToUsd, formatCredits, formatDate, humanize, normalizePrices } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";
import type { Billing, CheckoutResult, Usage } from "../lib/types.ts";
import { sinceDays, summarizeUsage } from "../lib/usage.ts";
import { useAction, useApi, useDocumentTitle } from "../lib/use-api.ts";

const RANGES = [7, 30, 90] as const;

function signed(delta: number): string {
  if (!delta) return "—";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("en-US")}`;
}

function UsageSection() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  // Rounded to the hour so the path, and therefore the request, is stable across re-renders.
  const since = useMemo(() => {
    const d = new Date(sinceDays(days));
    d.setMinutes(0, 0, 0);
    return d.toISOString();
  }, [days]);
  const usage = useApi<Usage>(`/api/usage?since=${encodeURIComponent(since)}`);

  return (
    <section className="panel" aria-labelledby="usage-title">
      <div className="panel-head">
        <h2 id="usage-title" className="h3">
          Usage
        </h2>
        <label className="field field-inline">
          <span className="field-label">Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value) as (typeof RANGES)[number])}>
            {RANGES.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      <Async state={usage} label="Loading usage">
        {(data) => {
          const rows = summarizeUsage(data.events ?? []);
          const total = rows.reduce((sum, r) => sum + r.credits, 0);
          const ledger = [...(data.ledger ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return (
            <>
              {rows.length === 0 ? (
                <EmptyState title="No usage in this period" />
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <caption className="visually-hidden">Usage by day and operation</caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Operation</th>
                        <th scope="col" className="num">
                          Events
                        </th>
                        <th scope="col" className="num">
                          Credits
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={`${r.date}:${r.operation}`}>
                          <td className="nowrap">{formatDate(`${r.date}T00:00:00`, false)}</td>
                          <th scope="row">{humanize(r.operation)}</th>
                          <td className="num">{r.count}</td>
                          <td className="num">{formatCredits(r.credits)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={3}>
                          Total
                        </th>
                        <td className="num">{formatCredits(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {ledger.length > 0 ? (
                <details className="disclosure">
                  <summary>Ledger ({ledger.length} entries)</summary>
                  <div className="table-scroll">
                    <table className="data-table">
                      <caption className="visually-hidden">Credit ledger</caption>
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">Entry</th>
                          <th scope="col" className="num">
                            Available
                          </th>
                          <th scope="col" className="num">
                            Held
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledger.map((entry) => (
                          <tr key={entry.id}>
                            <td className="nowrap">{formatDate(entry.createdAt)}</td>
                            <td>
                              {humanize(entry.kind)}
                              {entry.operation ? (
                                <span className="muted"> · {humanize(entry.operation)}</span>
                              ) : null}
                            </td>
                            <td className="num">{signed(entry.availableDelta)}</td>
                            <td className="num">{signed(entry.heldDelta)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </>
          );
        }}
      </Async>
    </section>
  );
}

export function BillingPage() {
  useDocumentTitle("Usage & billing");
  const { me } = useSession();
  const billing = useApi<Billing>("/api/billing");
  const checkout = useAction();
  const [checkoutDisabled, setCheckoutDisabled] = useState(false);

  const credits = billing.data?.credits ?? me.credits;
  const prices = useMemo(() => normalizePrices(billing.data?.prices), [billing.data]);
  const enabled = billing.data?.checkout?.enabled === true && !checkoutDisabled;

  async function buy() {
    const result = await checkout.run(() => api.post<CheckoutResult>("/api/billing/checkout"));
    if (!result) return;
    if (result.enabled && result.url) window.location.assign(result.url);
    else setCheckoutDisabled(true);
  }

  return (
    <>
      <PageHeader
        title="Usage & billing"
        intro="Credits pay for direction, rendering and generated assets."
      />

      <section className="stat-grid" aria-label="Balance">
        <div className="stat">
          <p className="stat-label">Balance</p>
          <p className="stat-value">{formatCredits(credits.balance)}</p>
          <p className="stat-note">{creditsToUsd(credits.balance)} · 1 credit = $0.01</p>
        </div>
        <div className="stat">
          <p className="stat-label">Held by running jobs</p>
          <p className="stat-value">{formatCredits(credits.held)}</p>
        </div>
        <div className="stat stat-action">
          <button
            type="button"
            className="btn btn-primary"
            onClick={buy}
            disabled={!enabled || checkout.pending}
            aria-describedby="checkout-note"
          >
            {checkout.pending ? "Opening checkout…" : "Buy credits"}
          </button>
          <p id="checkout-note" className="stat-note">
            {billing.data === undefined
              ? "Checking checkout availability…"
              : enabled
                ? "Secure checkout by Polar. Credits land in this workspace."
                : "Online checkout is not available yet. Contact us to add credits."}
          </p>
          {checkout.error ? (
            <p className="form-error" role="alert">
              {checkout.error}
            </p>
          ) : null}
        </div>
      </section>

      <UsageSection />

      <section className="panel" aria-labelledby="prices-title">
        <h2 id="prices-title" className="h3">
          Prices
        </h2>
        {billing.data === undefined ? (
          billing.error ? (
            <ErrorState message={billing.error} onRetry={billing.reload} />
          ) : (
            <Loading label="Loading prices" />
          )
        ) : prices.length === 0 ? (
          <EmptyState title="No prices published" />
        ) : (
          <div className="table-scroll">
            <table className="data-table price-table">
              <caption className="visually-hidden">Credit prices</caption>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className="num">
                    Credits
                  </th>
                  <th scope="col" className="num">
                    USD
                  </th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.operation}>
                    <th scope="row">{humanize(p.operation)}</th>
                    <td>{p.unit}</td>
                    <td className="num">{p.credits}</td>
                    <td className="num">{creditsToUsd(p.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
