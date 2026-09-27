# Billing

Credits, reservations and the ledger are implemented in `packages/billing` and
applied by `packages/pipeline/src/billing-guard.ts`. The reasoning is in
[ADR 0010](decisions/0010-credit-ledger-billing.md).

## Credits and prices

- **1 credit = US$0.01.** Credits are whole integers in the ledger.
- The price list is `CREDIT_PRICES` in `packages/billing/src/prices.ts`. It is
  the only authority for credit prices, and `motion_inspect` capabilities
  serves it live under `pricing`. Do not copy the numbers into other documents.
- Every price is set from a conservative estimated cost of goods (list prices,
  no volume discounts, one retry included) so that gross margin is at least 60%.
  A unit test enforces that floor for every operation. When a provider price or
  the render footprint changes, update the estimate and the price together.
- Internal costs (COGS) are tracked separately on trace spans
  ([OBSERVABILITY.md](OBSERVABILITY.md)), so rounding never leaks into
  balances.

What a job is charged:

- Every job pays one orchestration line.
- `internal-opus` creates pay one director line. A `host-opus` job never pays
  it, because the host already paid for its own model.
- Each internal critique, and each free-text edit interpreted by the director,
  pays one critique line.
- Renders pay per draft preview, and per output minute for finals.
- Each scene image the job generates pays one `image_generation` line, or zero
  credits when the workspace's own key paid for it (see [BYOK](#byok)).
- The table also prices video, speech, music and sound-effect generation,
  storage and API calls. They are not metered yet, because those media steps
  are not wired into the pipeline and storage and request metering do not exist
  yet.

## Reservations

Before a job is enqueued, the pipeline quotes it with `quoteJob`
(`packages/billing/src/quote.ts`) and reserves the quote from the workspace
balance:

- The quote covers the worst case. For internal modes it includes the maximum
  number of critiques the job may run. When an image provider is available, it
  includes `ASSET_IMAGES_PER_JOB` images; under a `budgetCredits` that cannot
  cover them all, the image allowance shrinks instead of failing the job.
- If the caller's `budgetCredits` is below the quote, the call fails with
  `budget_exceeded` before anything runs.
- If the available balance cannot cover the quote, the call fails with
  `insufficient_credits`.
- When the job finishes, or pauses for a host critique, the ledger captures only
  the credits actually used, returns the rest, and records one usage event per
  line.
- A failed, cancelled or interrupted job releases its whole reservation.
- During the job, the remaining budget is the caller's `budgetCredits`, or the
  reservation when none is given. Internal critiques and the final render check
  it before they run (see [JEV_ROUTING.md](JEV_ROUTING.md#budgets-and-caps)).

## Trial credits

`TRIAL_CREDITS` (default 500) is granted once per workspace, the first time the
workspace starts a job. The grant is idempotent on its key, so restarts and
concurrent calls never double-grant. Setting it to 0 disables the trial. The
default workspace used by static keys and the CLI also receives it.

## Ledger design

The ledger (`packages/billing/src/ledger.ts`) is double-entry: every
transaction is a set of entries that sum to zero.

| Account | Meaning |
|---|---|
| `workspace:<id>:available` | Spendable balance |
| `workspace:<id>:held` | Credits reserved for running jobs |
| `source:<source>` | Counter-account for grants, such as `source:polar` or `source:trial`. It goes negative as credits are issued. |
| `platform:usage` | Credits consumed by billable work |

The ledger enforces these rules:

- Balances are derived by summing entries. There is no mutable balance to
  drift.
- Every mutation accepts an idempotency key, which makes webhook and job
  retries safe.
- `available` can never go negative unless an overdraft limit is configured
  (none is today).
- Corrections are new transactions. Entries are never updated or deleted.

The runtime stores the ledger as an append-only JSONL file under `DATA_DIR`.
It locks per process, so a data directory must have a single writer. The
PostgreSQL `credit_ledger` table in `packages/database/src/schema.ts` is
**planned** as the production store.

## Polar webhooks

Polar sells credit top-ups. `POST /webhooks/polar` is handled by
`handlePolarWebhook` in `packages/billing/src/polar.ts`:

- It verifies the Standard Webhooks signature (`webhook-id`,
  `webhook-timestamp`, `webhook-signature`) against `POLAR_WEBHOOK_SECRET` on the
  raw body, and rejects missing, invalid, stale or future-dated requests.
- `order.paid` grants credits to the workspace named by the order's
  `metadata.workspace_id`, or else the customer's `external_id`. The amount is
  the USD net amount in cents, one credit per cent. The grant is idempotent per
  order id, so Polar redeliveries are harmless.
- Every other event is acknowledged without side effects.

**Planned:** checkout creation (which must set the workspace reference, and is
what `POLAR_ACCESS_TOKEN` and `POLAR_ENVIRONMENT` are declared for),
subscription grants, refund reversals, and per-product credit packs.

## BYOK

A workspace stores its own provider credentials under **Dashboard > Model
providers**, encrypted as described in
[SECURITY.md](SECURITY.md#provider-credentials-byok). Its keys pay the model
and media providers directly:

- Scene images generated with the workspace's multix key are recorded as
  `image_generation` lines with `byok: true` and zero credits. The price table
  flags which lines a workspace key may waive (`byokWaivable`); today that is
  only third-party media generation.
- Scene workers running on the workspace's pi sign-in spend the workspace's
  tokens; scene implementation was never a separate credit line.
- Orchestration, the internal creative director, critiques, renders, storage
  and API calls are always charged, because the platform still runs and pays
  for them.

## Limits

- Per job: `budgetCredits`, and the duration, scene and brief limits reported by
  `motion_inspect` capabilities.
- Per server: `JOB_CONCURRENCY` jobs run at once, and the rest queue.
- Per-key request rate limits and per-workspace concurrency caps are
  **planned**.

## Margin tracking

Each job's trace summary carries its COGS, and the captured credits are its
revenue. `margin()` in `packages/observability` computes gross profit and gross
margin from the two. Writing margin onto the root span and aggregating it per
operation, director mode and workspace is **planned**. A negative margin on any
operation line is the signal to change the price table or the routing
thresholds.
