# 0010. Internal credit ledger with Polar for payments

## Status

Accepted.

## Context

Each job has a variable cost made up of Opus tokens, cheap-model tokens, render
CPU, media providers and storage. Gross margin is part of the product's
[success metric](../PRODUCT.md#success-metric). Users may bring their own
provider keys (BYOK).

## Decision

- An internal double-entry **credit ledger** is the only record of spend, with
  **1 credit = US$0.01**.
- **Polar.sh** is used only for top-ups and subscriptions. Its webhooks grant
  credits idempotently, and Polar never meters individual operations.
- Jobs reserve credits at start, capture them per billable step, and release the
  remainder at the end.
- **BYOK** workspaces still pay credits for platform and orchestration fees,
  renders, storage and internal Opus calls. Opus always runs on the platform's
  key.

The details are in [BILLING.md](../BILLING.md).

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| Usage-based metering in Polar for each operation | Couples every pipeline step to a payment provider's API and latency, and makes budget checks remote. |
| Stripe | Polar covers top-ups and subscriptions with less integration work for this scope. The ledger keeps the payment provider replaceable. |
| Flat subscription only | Variable costs from renders and Opus would make margin unpredictable. |
| BYOK with no platform fee | Rendering, storage and orchestration still cost money. |

## Reason

An internal ledger makes budget checks local, exact and testable. The payment
provider only moves money in.

## Trade-offs

- The ledger code needs careful testing: double entry, idempotency, and no
  negative balances.
- Prices must be maintained against provider price changes.

## Migration strategy

Price changes are edits to the price table and apply to new reservations only.
Replacing Polar means writing a new webhook adapter that posts the same ledger
transactions.
