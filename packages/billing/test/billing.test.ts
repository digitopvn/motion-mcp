import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BILLABLE_OPERATIONS,
  CREDIT_PRICES,
  CreditLedger,
  handlePolarWebhook,
  InMemoryLedgerStore,
  JsonlLedgerStore,
  type LedgerStore,
  priceMargin,
  quoteJob,
  signWebhook,
  TARGET_MARGIN,
  verifyWebhook,
} from "../src/index.ts";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function sumOfAllEntries(store: LedgerStore): Promise<number> {
  const txs = await store.list();
  return txs.flatMap((t) => t.entries).reduce((s, e) => s + e.amount, 0);
}

describe("prices", () => {
  it("every billable operation is priced at or above the target margin", () => {
    for (const op of BILLABLE_OPERATIONS) {
      expect(Number.isInteger(CREDIT_PRICES[op].credits), op).toBe(true);
      expect(priceMargin(op), op).toBeGreaterThanOrEqual(TARGET_MARGIN);
    }
  });
});

describe("quoteJob", () => {
  it("prices a 30 s internal-opus HD job", () => {
    const q = quoteJob({
      durationSeconds: 30,
      previews: 2,
      critiqueLoops: 1,
      ttsChars: 1500,
      musicTracks: 1,
    });
    const byOp = Object.fromEntries(q.lines.map((l) => [l.operation, l.credits]));
    expect(byOp).toEqual({
      orchestration_job: 20,
      creative_direction: 100,
      creative_critique: 40,
      preview_render: 16,
      render_minute_hd: 13, // 0.5 min * 25 = 12.5 -> 13
      tts_1k_chars: 23, // 1.5 * 15 = 22.5 -> 23
      music_track: 100,
    });
    expect(q.totalCredits).toBe(312);
    expect(q.totalUsd).toBe(3.12);
  });

  it("skips the director in host-opus mode and waives provider costs under BYOK", () => {
    const q = quoteJob({
      durationSeconds: 60,
      resolution: "4k",
      directorMode: "host-opus",
      critiqueLoops: 0,
      previews: 0,
      images: 3,
      byok: true,
    });
    expect(q.lines.find((l) => l.operation === "creative_direction")).toBeUndefined();
    expect(q.lines.find((l) => l.operation === "image_generation")).toMatchObject({
      credits: 0,
      waived: true,
    });
    expect(q.lines.find((l) => l.operation === "render_minute_4k")).toMatchObject({
      credits: 80,
      waived: false,
    });
    expect(q.totalCredits).toBe(100);
  });

  it("rejects invalid plans", () => {
    expect(() => quoteJob({ durationSeconds: -1 })).toThrow(/Invalid job plan/);
  });
});

describe.each([
  ["in-memory", async () => new InMemoryLedgerStore()],
  [
    "jsonl",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ledger-"));
      tmpDirs.push(dir);
      return new JsonlLedgerStore(join(dir, "ledger.jsonl"));
    },
  ],
] as const)("CreditLedger (%s store)", (_name, makeStore) => {
  it("keeps balances equal to the sum of entries across grant/reserve/capture/release", async () => {
    const store = await makeStore();
    const ledger = new CreditLedger(store);
    await ledger.grant({ workspaceId: "ws1", credits: 1000, source: "polar", idempotencyKey: "order-1" });
    const r1 = await ledger.reserve({ workspaceId: "ws1", credits: 300 });
    expect(await ledger.balance("ws1")).toEqual({ available: 700, held: 300, total: 1000 });

    await ledger.capture({ reservationId: r1.id, credits: 120, operation: "render_minute_hd" });
    expect(await ledger.balance("ws1")).toEqual({ available: 880, held: 0, total: 880 });

    const r2 = await ledger.reserve({ workspaceId: "ws1", credits: 200 });
    await ledger.release({ reservationId: r2.id });
    expect(await ledger.balance("ws1")).toEqual({ available: 880, held: 0, total: 880 });
    expect(await ledger.getReservation(r2.id)).toMatchObject({ status: "released" });

    const r3 = await ledger.reserve({ workspaceId: "ws1", credits: 50 });
    await ledger.capture({ reservationId: r3.id, credits: 80 }); // overrun drawn from available
    expect(await ledger.balance("ws1")).toEqual({ available: 800, held: 0, total: 800 });

    expect(await sumOfAllEntries(store)).toBe(0);
    for (const tx of await store.list()) expect(tx.entries.reduce((s, e) => s + e.amount, 0)).toBe(0);
  });

  it("is idempotent per key and rejects key reuse across operations", async () => {
    const ledger = new CreditLedger(await makeStore());
    const a = await ledger.grant({ workspaceId: "ws2", credits: 500, source: "polar", idempotencyKey: "k1" });
    const b = await ledger.grant({ workspaceId: "ws2", credits: 500, source: "polar", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    expect((await ledger.balance("ws2")).available).toBe(500);

    const r1 = await ledger.reserve({ workspaceId: "ws2", credits: 100, idempotencyKey: "job-1" });
    const r2 = await ledger.reserve({ workspaceId: "ws2", credits: 100, idempotencyKey: "job-1" });
    expect(r2.id).toBe(r1.id);
    expect((await ledger.balance("ws2")).held).toBe(100);

    await ledger.capture({ reservationId: r1.id, credits: 60, idempotencyKey: "cap-1" });
    const again = await ledger.capture({ reservationId: r1.id, credits: 60, idempotencyKey: "cap-1" });
    expect(again.status).toBe("captured");
    await expect(ledger.capture({ reservationId: r1.id, credits: 10 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      ledger.grant({ workspaceId: "ws2", credits: 1, source: "polar", idempotencyKey: "job-1" }),
    ).rejects.toThrow(/different ledger operation/);
    expect((await ledger.balance("ws2")).available).toBe(440);
  });

  it("prevents negative balances unless an overdraft limit is set", async () => {
    const store = await makeStore();
    const strict = new CreditLedger(store);
    await strict.grant({ workspaceId: "ws3", credits: 100, source: "manual", idempotencyKey: "g3" });
    await expect(strict.reserve({ workspaceId: "ws3", credits: 101 })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    const r = await strict.reserve({ workspaceId: "ws3", credits: 100 });
    await expect(strict.capture({ reservationId: r.id, credits: 150 })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });

    const lenient = new CreditLedger(store, { overdraftLimit: () => 50 });
    await lenient.capture({ reservationId: r.id, credits: 150 });
    expect(await lenient.balance("ws3")).toEqual({ available: -50, held: 0, total: -50 });
    await expect(lenient.reserve({ workspaceId: "ws3", credits: 1 })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("serializes concurrent reservations so the balance cannot be overspent", async () => {
    const ledger = new CreditLedger(await makeStore());
    await ledger.grant({ workspaceId: "ws4", credits: 500, source: "manual", idempotencyKey: "g4" });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ledger.reserve({ workspaceId: "ws4", credits: 100 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await ledger.balance("ws4")).toEqual({ available: 0, held: 500, total: 500 });
  });

  it("validates inputs", async () => {
    const ledger = new CreditLedger(await makeStore());
    await expect(
      ledger.grant({ workspaceId: "ws5", credits: 1.5, source: "polar", idempotencyKey: "x" }),
    ).rejects.toThrow(/integer/);
    await expect(ledger.reserve({ workspaceId: "../etc", credits: 1 })).rejects.toThrow(/workspaceId/);
    await expect(ledger.capture({ reservationId: "rsv_missing", credits: 1 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("JsonlLedgerStore persistence", () => {
  it("replays the log and drops a torn final line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    tmpDirs.push(dir);
    const path = join(dir, "ledger.jsonl");
    const ledger = new CreditLedger(new JsonlLedgerStore(path));
    await ledger.grant({ workspaceId: "ws6", credits: 42, source: "polar", idempotencyKey: "g6" });
    await writeFile(path, `${await readFile(path, "utf8")}{"id":"torn`, "utf8");

    const reopened = new CreditLedger(new JsonlLedgerStore(path));
    expect((await reopened.balance("ws6")).available).toBe(42);
    await reopened.grant({ workspaceId: "ws6", credits: 8, source: "polar", idempotencyKey: "g6" });
    await reopened.grant({ workspaceId: "ws6", credits: 8, source: "polar", idempotencyKey: "g7" });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((await new CreditLedger(new JsonlLedgerStore(path)).balance("ws6")).available).toBe(50);
  });
});

describe("Polar webhooks", () => {
  const secret = `whsec_${Buffer.from("super-secret-test-key-0123456789").toString("base64")}`;
  const now = 1_790_000_000_000;
  const order = {
    type: "order.paid",
    data: {
      id: "ord_123",
      currency: "usd",
      net_amount: 2000,
      subtotal_amount: 2000,
      product_id: "prod_basic",
      metadata: { workspace_id: "ws_polar" },
      customer: { external_id: null },
    },
  };
  const signed = (body: string, ts = Math.floor(now / 1000), key = secret) => ({
    "webhook-id": "msg_1",
    "webhook-timestamp": String(ts),
    "webhook-signature": signWebhook(key, "msg_1", ts, body),
  });

  it("accepts a valid signature and grants credits once per order", async () => {
    const body = JSON.stringify(order);
    const ledger = new CreditLedger(new InMemoryLedgerStore());
    const input = { headers: signed(body), body, secret, ledger, now: () => now };
    const first = await handlePolarWebhook(input);
    expect(first).toMatchObject({ type: "order.paid", handled: true });
    await handlePolarWebhook(input); // redelivery
    expect((await ledger.balance("ws_polar")).available).toBe(2000);

    const mapped = await handlePolarWebhook({ ...input, creditsByProduct: { prod_basic: 2500 } });
    expect(mapped.transaction?.id).toBe(first.transaction?.id);
  });

  it("supports plain Polar secrets and multiple signatures", () => {
    const plain = "polar-plain-secret";
    const body = "{}";
    const headers = signed(body, Math.floor(now / 1000), plain);
    headers["webhook-signature"] = `v1,AAAA ${headers["webhook-signature"]}`;
    expect(verifyWebhook({ headers: new Headers(headers), body, secret: plain, now: () => now })).toEqual({});
  });

  it("rejects tampered bodies, wrong secrets and missing headers", () => {
    const body = JSON.stringify(order);
    const headers = signed(body);
    expect(() =>
      verifyWebhook({ headers, body: body.replace("2000", "9000"), secret, now: () => now }),
    ).toThrow(/Invalid webhook signature/);
    expect(() => verifyWebhook({ headers, body, secret: "whsec_d3Jvbmc=", now: () => now })).toThrow(
      /signature/,
    );
    expect(() => verifyWebhook({ headers: {}, body, secret, now: () => now })).toThrow(/Missing/);
  });

  it("rejects expired and future timestamps", () => {
    const body = JSON.stringify(order);
    const old = signed(body, Math.floor(now / 1000) - 301);
    expect(() => verifyWebhook({ headers: old, body, secret, now: () => now })).toThrow(/too old/);
    const future = signed(body, Math.floor(now / 1000) + 301);
    expect(() => verifyWebhook({ headers: future, body, secret, now: () => now })).toThrow(/future/);
  });

  it("acknowledges other events without granting and rejects orders without a workspace", async () => {
    const ledger = new CreditLedger(new InMemoryLedgerStore());
    const refund = JSON.stringify({ type: "order.refunded", data: order.data });
    expect(
      await handlePolarWebhook({ headers: signed(refund), body: refund, secret, ledger, now: () => now }),
    ).toEqual({ type: "order.refunded", handled: false });

    const orphan = JSON.stringify({ ...order, data: { ...order.data, metadata: {} } });
    await expect(
      handlePolarWebhook({ headers: signed(orphan), body: orphan, secret, ledger, now: () => now }),
    ).rejects.toThrow(/no workspace/);
  });
});
