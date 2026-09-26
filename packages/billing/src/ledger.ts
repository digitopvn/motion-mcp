import { MotionError, newId } from "@motion-mcp/shared";
import type { LedgerEntry, LedgerStore, LedgerTransaction } from "./ledger-store.ts";

/** Account naming. Every transaction's entries sum to zero across these accounts. */
export const accounts = {
  available: (workspaceId: string) => `workspace:${workspaceId}:available`,
  held: (workspaceId: string) => `workspace:${workspaceId}:held`,
  /** Counter-account for top-ups (for example `source:polar`); it goes negative as credits are sold. */
  source: (source: string) => `source:${source}`,
  /** Credits consumed by billable work. */
  usage: "platform:usage",
} as const;

export interface Balance {
  available: number;
  held: number;
  /** available + held */
  total: number;
}

export interface Reservation {
  id: string;
  workspaceId: string;
  credits: number;
  status: "open" | "captured" | "released";
  capturedCredits?: number;
}

export interface CreditLedgerOptions {
  /**
   * How far `available` may go below zero, per workspace. Defaults to 0: no negative balances.
   * Return a positive number of credits to allow postpaid overdraft.
   */
  overdraftLimit?: (workspaceId: string) => number;
  now?: () => Date;
}

type Metadata = Record<string, string | number | boolean>;

function assertCredits(value: number, what: string, allowZero = false): void {
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new MotionError(
      "VALIDATION",
      `${what} must be a ${allowZero ? "non-negative" : "positive"} integer`,
      {
        details: { value },
      },
    );
  }
}

function assertId(value: string, what: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(value)) {
    throw new MotionError("VALIDATION", `invalid ${what}`);
  }
}

/**
 * Double-entry credit ledger. All balances are derived from the transaction log, never stored,
 * so the log is the single source of truth. Mutations are serialized per ledger instance and every
 * mutation accepts an idempotency key so retried webhooks and job steps never double-charge.
 */
export class CreditLedger {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly overdraft: (workspaceId: string) => number;
  private readonly now: () => Date;

  constructor(
    private readonly store: LedgerStore,
    options: CreditLedgerOptions = {},
  ) {
    this.overdraft = options.overdraftLimit ?? (() => 0);
    this.now = options.now ?? (() => new Date());
  }

  /** Top up a workspace (for example from a paid Polar order). */
  async grant(input: {
    workspaceId: string;
    credits: number;
    source: string;
    idempotencyKey: string;
    metadata?: Metadata;
  }): Promise<LedgerTransaction> {
    assertId(input.workspaceId, "workspaceId");
    assertId(input.source, "grant source");
    assertCredits(input.credits, "grant credits");
    return this.serialized(async () => {
      const existing = await this.idempotent(input.idempotencyKey, "grant", input.workspaceId);
      if (existing) return existing;
      return this.commit({
        kind: "grant",
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
        entries: [
          { account: accounts.source(input.source), amount: -input.credits },
          { account: accounts.available(input.workspaceId), amount: input.credits },
        ],
      });
    });
  }

  /** Hold credits before a job runs. Fails with BUDGET_EXCEEDED if the balance cannot cover it. */
  async reserve(input: {
    workspaceId: string;
    credits: number;
    idempotencyKey?: string;
    metadata?: Metadata;
  }): Promise<Reservation> {
    assertId(input.workspaceId, "workspaceId");
    assertCredits(input.credits, "reservation credits");
    return this.serialized(async () => {
      const existing = await this.idempotent(input.idempotencyKey, "reserve", input.workspaceId);
      if (existing?.reservationId) return this.reservationOrThrow(existing.reservationId);
      await this.ensureAvailable(input.workspaceId, input.credits);
      const reservationId = newId("rsv");
      await this.commit({
        kind: "reserve",
        workspaceId: input.workspaceId,
        reservationId,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
        entries: [
          { account: accounts.available(input.workspaceId), amount: -input.credits },
          { account: accounts.held(input.workspaceId), amount: input.credits },
        ],
      });
      return { id: reservationId, workspaceId: input.workspaceId, credits: input.credits, status: "open" };
    });
  }

  /**
   * Settle a reservation with the actual usage. Unused credits return to `available`; usage above the
   * hold is drawn from `available` and is subject to the same no-negative/overdraft rule.
   */
  async capture(input: {
    reservationId: string;
    credits: number;
    operation?: string;
    idempotencyKey?: string;
    metadata?: Metadata;
  }): Promise<Reservation> {
    assertCredits(input.credits, "captured credits", true);
    return this.serialized(async () => {
      const reservation = await this.reservationOrThrow(input.reservationId);
      const existing = await this.idempotent(
        input.idempotencyKey,
        "capture",
        reservation.workspaceId,
        reservation.id,
      );
      if (existing) return reservation;
      this.assertOpen(reservation);
      const ws = reservation.workspaceId;
      const extra = input.credits - reservation.credits;
      if (extra > 0) await this.ensureAvailable(ws, extra);
      await this.commit({
        kind: "capture",
        workspaceId: ws,
        reservationId: reservation.id,
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        metadata: input.metadata,
        entries: [
          { account: accounts.held(ws), amount: -reservation.credits },
          { account: accounts.usage, amount: input.credits },
          { account: accounts.available(ws), amount: -extra },
        ],
      });
      return { ...reservation, status: "captured", capturedCredits: input.credits };
    });
  }

  /** Cancel a reservation and return all held credits. */
  async release(input: {
    reservationId: string;
    idempotencyKey?: string;
    metadata?: Metadata;
  }): Promise<Reservation> {
    return this.serialized(async () => {
      const reservation = await this.reservationOrThrow(input.reservationId);
      const existing = await this.idempotent(
        input.idempotencyKey,
        "release",
        reservation.workspaceId,
        reservation.id,
      );
      if (existing) return reservation;
      this.assertOpen(reservation);
      const ws = reservation.workspaceId;
      await this.commit({
        kind: "release",
        workspaceId: ws,
        reservationId: reservation.id,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
        entries: [
          { account: accounts.held(ws), amount: -reservation.credits },
          { account: accounts.available(ws), amount: reservation.credits },
        ],
      });
      return { ...reservation, status: "released" };
    });
  }

  async balance(workspaceId: string): Promise<Balance> {
    assertId(workspaceId, "workspaceId");
    const txs = await this.store.list({ workspaceId });
    const available = accounts.available(workspaceId);
    const held = accounts.held(workspaceId);
    let a = 0;
    let h = 0;
    for (const tx of txs) {
      for (const e of tx.entries) {
        if (e.account === available) a += e.amount;
        else if (e.account === held) h += e.amount;
      }
    }
    return { available: a, held: h, total: a + h };
  }

  async getReservation(reservationId: string): Promise<Reservation | undefined> {
    const txs = await this.store.list({ reservationId });
    const opened = txs.find((t) => t.kind === "reserve");
    if (!opened) return undefined;
    const credits = opened.entries.find((e) => e.account === accounts.held(opened.workspaceId))?.amount ?? 0;
    const base: Reservation = { id: reservationId, workspaceId: opened.workspaceId, credits, status: "open" };
    const closed = txs.find((t) => t.kind === "capture" || t.kind === "release");
    if (closed?.kind === "release") return { ...base, status: "released" };
    if (closed?.kind === "capture") {
      const used = closed.entries.find((e) => e.account === accounts.usage)?.amount ?? 0;
      return { ...base, status: "captured", capturedCredits: used };
    }
    return base;
  }

  private async reservationOrThrow(reservationId: string): Promise<Reservation> {
    const reservation = await this.getReservation(reservationId);
    if (!reservation) throw new MotionError("NOT_FOUND", `Unknown reservation ${reservationId}`);
    return reservation;
  }

  private assertOpen(reservation: Reservation): void {
    if (reservation.status !== "open") {
      throw new MotionError("VALIDATION", `Reservation ${reservation.id} is already ${reservation.status}`);
    }
  }

  private async ensureAvailable(workspaceId: string, credits: number): Promise<void> {
    const { available } = await this.balance(workspaceId);
    const limit = Math.max(0, this.overdraft(workspaceId));
    if (available - credits < -limit) {
      throw new MotionError("BUDGET_EXCEEDED", "Insufficient credits", {
        details: { workspaceId, available, requested: credits, overdraftLimit: limit },
      });
    }
  }

  private async idempotent(
    key: string | undefined,
    kind: LedgerTransaction["kind"],
    workspaceId: string,
    reservationId?: string,
  ): Promise<LedgerTransaction | undefined> {
    if (key === undefined) return undefined;
    if (key.length === 0 || key.length > 200) throw new MotionError("VALIDATION", "invalid idempotency key");
    const existing = await this.store.findByIdempotencyKey(key);
    if (!existing) return undefined;
    if (
      existing.kind !== kind ||
      existing.workspaceId !== workspaceId ||
      (reservationId !== undefined && existing.reservationId !== reservationId)
    ) {
      throw new MotionError("VALIDATION", "Idempotency key already used for a different ledger operation", {
        details: { key, existingKind: existing.kind },
      });
    }
    return existing;
  }

  private async commit(
    tx: Omit<LedgerTransaction, "id" | "createdAt" | "entries"> & { entries: LedgerEntry[] },
  ): Promise<LedgerTransaction> {
    const entries = tx.entries.filter((e) => e.amount !== 0);
    const sum = entries.reduce((s, e) => s + e.amount, 0);
    if (sum !== 0 || entries.length < 2) {
      throw new MotionError("INTERNAL", "Unbalanced ledger transaction", { details: { kind: tx.kind, sum } });
    }
    const full: LedgerTransaction = {
      ...tx,
      entries,
      id: newId("ltx"),
      createdAt: this.now().toISOString(),
    };
    await this.store.append(full);
    return full;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
