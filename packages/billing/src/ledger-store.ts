import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";

export const LedgerEntry = z.object({
  account: z.string().min(1).max(200),
  /** Integer credits; positive credits the account, negative debits it. */
  amount: z.number().int(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const LedgerTransaction = z.object({
  id: z.string().min(1),
  kind: z.enum(["grant", "reserve", "capture", "release"]),
  workspaceId: z.string().min(1),
  entries: z.array(LedgerEntry).min(2),
  idempotencyKey: z.string().min(1).max(200).optional(),
  reservationId: z.string().optional(),
  operation: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  createdAt: z.string(),
});
export type LedgerTransaction = z.infer<typeof LedgerTransaction>;

export interface LedgerFilter {
  workspaceId?: string;
  reservationId?: string;
}

/** Append-only transaction log. Implementations must preserve append order. */
export interface LedgerStore {
  append(tx: LedgerTransaction): Promise<void>;
  list(filter?: LedgerFilter): Promise<LedgerTransaction[]>;
  findByIdempotencyKey(key: string): Promise<LedgerTransaction | undefined>;
}

function matches(tx: LedgerTransaction, filter: LedgerFilter): boolean {
  if (filter.workspaceId !== undefined && tx.workspaceId !== filter.workspaceId) return false;
  if (filter.reservationId !== undefined && tx.reservationId !== filter.reservationId) return false;
  return true;
}

export class InMemoryLedgerStore implements LedgerStore {
  private readonly txs: LedgerTransaction[] = [];
  private readonly byKey = new Map<string, LedgerTransaction>();

  async append(tx: LedgerTransaction): Promise<void> {
    this.add(tx);
  }

  async list(filter: LedgerFilter = {}): Promise<LedgerTransaction[]> {
    return this.txs.filter((tx) => matches(tx, filter)).map((tx) => structuredClone(tx));
  }

  async findByIdempotencyKey(key: string): Promise<LedgerTransaction | undefined> {
    const tx = this.byKey.get(key);
    return tx ? structuredClone(tx) : undefined;
  }

  /** Synchronous insert used by the file store when replaying its log. */
  add(tx: LedgerTransaction): void {
    if (tx.idempotencyKey !== undefined) {
      if (this.byKey.has(tx.idempotencyKey)) {
        throw new MotionError("VALIDATION", `Duplicate ledger idempotency key ${tx.idempotencyKey}`);
      }
      this.byKey.set(tx.idempotencyKey, tx);
    }
    this.txs.push(structuredClone(tx));
  }
}

/**
 * JSON-lines ledger for local and single-node deploys: one transaction per line, fsync'd on append.
 * The log is replayed into memory on first use. A torn final line (crash mid-write) is truncated away;
 * any other malformed line is treated as corruption and fails loudly.
 * Not safe for multiple processes writing the same file; use the Postgres ledger for that.
 */
export class JsonlLedgerStore implements LedgerStore {
  private memory?: Promise<InMemoryLedgerStore>;

  constructor(readonly path: string) {}

  async append(tx: LedgerTransaction): Promise<void> {
    const mem = await this.load();
    const valid = LedgerTransaction.parse(tx);
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    try {
      await handle.write(`${JSON.stringify(valid)}\n`);
      await handle.datasync();
    } finally {
      await handle.close();
    }
    mem.add(valid);
  }

  async list(filter: LedgerFilter = {}): Promise<LedgerTransaction[]> {
    return (await this.load()).list(filter);
  }

  async findByIdempotencyKey(key: string): Promise<LedgerTransaction | undefined> {
    return (await this.load()).findByIdempotencyKey(key);
  }

  private load(): Promise<InMemoryLedgerStore> {
    this.memory ??= this.replay().catch((err: unknown) => {
      this.memory = undefined;
      throw err;
    });
    return this.memory;
  }

  private async replay(): Promise<InMemoryLedgerStore> {
    const mem = new InMemoryLedgerStore();
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return mem;
      throw err;
    }
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline !== raw.length - 1) {
      // Torn write: drop the partial tail so the next append starts on a clean line.
      await truncate(this.path, Buffer.byteLength(raw.slice(0, lastNewline + 1), "utf8"));
      raw = raw.slice(0, lastNewline + 1);
    }
    const lines = raw.split("\n");
    for (const [i, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new MotionError("INTERNAL", `Ledger file corrupted at line ${i + 1}`, { cause: err });
      }
      const tx = LedgerTransaction.safeParse(parsed);
      if (!tx.success)
        throw new MotionError("INTERNAL", `Ledger file has an invalid transaction at line ${i + 1}`);
      mem.add(tx.data);
    }
    return mem;
  }
}
