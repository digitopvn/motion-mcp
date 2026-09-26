import {
  type BillableOperation,
  type CreditLedger,
  creditsToUsd,
  type JobQuote,
  priceOf,
  type Reservation,
} from "@motion-mcp/billing";
import type { Logger } from "@motion-mcp/shared";
import { MotionError } from "@motion-mcp/shared";
import type { UsageLine } from "./job-record.ts";

/** Actual billable usage of one job, priced with the same table as the quote. */
export class UsageMeter {
  readonly lines: UsageLine[] = [];

  constructor(private readonly limitCredits: number) {}

  add(operation: BillableOperation, quantity: number): void {
    if (quantity <= 0) return;
    this.lines.push({ operation, quantity, credits: priceOf(operation, quantity) });
  }

  get credits(): number {
    return this.lines.reduce((sum, l) => sum + l.credits, 0);
  }

  /** Credits left under the job's budget (explicit budgetCredits, else the reservation), in USD. */
  remainingUsd(): number {
    return creditsToUsd(Math.max(0, this.limitCredits - this.credits));
  }
}

/**
 * Early-access trial: grant TRIAL_CREDITS once per workspace. The ledger grant is idempotent on the key, so
 * concurrent or repeated calls (and restarts) never double-grant; the in-memory set only saves lookups.
 */
export class TrialGrants {
  private readonly seen = new Set<string>();

  constructor(
    private readonly ledger: CreditLedger,
    private readonly credits: number,
    private readonly logger?: Logger,
  ) {}

  async ensure(workspaceId: string): Promise<void> {
    if (this.credits <= 0 || this.seen.has(workspaceId)) return;
    const tx = await this.ledger.grant({
      workspaceId,
      credits: this.credits,
      source: "trial",
      idempotencyKey: `trial:${workspaceId}`,
      metadata: { reason: "early-access trial" },
    });
    this.seen.add(workspaceId);
    this.logger?.debug("billing.trial", { workspaceId, transactionId: tx.id });
  }
}

/**
 * Hold the quoted credits before a job starts. A quote above the caller's budget stops with
 * BUDGET_EXCEEDED; a balance that cannot cover it stops with INSUFFICIENT_CREDITS.
 */
export async function reserveForJob(
  ledger: CreditLedger,
  input: { workspaceId: string; jobId: string; quote: JobQuote; budgetCredits?: number },
): Promise<Reservation> {
  const required = input.quote.totalCredits;
  if (input.budgetCredits !== undefined && required > input.budgetCredits) {
    throw new MotionError(
      "BUDGET_EXCEEDED",
      `This job is estimated at ${required} credits, above budgetCredits ${input.budgetCredits}`,
      { details: { estimatedCredits: required, budgetCredits: input.budgetCredits } },
    );
  }
  try {
    return await ledger.reserve({
      workspaceId: input.workspaceId,
      credits: Math.max(1, required),
      idempotencyKey: `job:${input.jobId}:reserve`,
      metadata: { jobId: input.jobId },
    });
  } catch (err) {
    if (err instanceof MotionError && err.code === "BUDGET_EXCEEDED") {
      const balance = await ledger.balance(input.workspaceId);
      throw new MotionError(
        "INSUFFICIENT_CREDITS",
        `This job needs ${required} credits but only ${balance.available} are available`,
        { details: { requiredCredits: required, availableCredits: balance.available } },
      );
    }
    throw err;
  }
}
