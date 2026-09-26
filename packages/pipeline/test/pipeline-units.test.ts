import { CreditLedger, InMemoryLedgerStore, quoteJob } from "@motion-mcp/billing";
import { MotionError } from "@motion-mcp/shared";
import { describe, expect, it } from "vitest";
import { ArtifactSigner, resolveSigningSecret } from "../src/artifact-urls.ts";
import { reserveForJob, TrialGrants } from "../src/billing-guard.ts";
import { JobQueue } from "../src/job-queue.ts";
import { bm25Search } from "../src/search.ts";

const BASE = "https://motion.example";

describe("ArtifactSigner", () => {
  const signer = new ArtifactSigner("secret-for-tests-0123456789", BASE);

  function parts(url: string) {
    const u = new URL(url);
    const key = u.pathname
      .replace(/^\/artifacts\//, "")
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    return { key, exp: u.searchParams.get("exp") ?? "", sig: u.searchParams.get("sig") ?? "" };
  }

  it("verifies its own URLs", () => {
    const { key, exp, sig } = parts(signer.sign("ws_a/prj_b/renders/rnd_c.mp4", 60));
    expect(key).toBe("ws_a/prj_b/renders/rnd_c.mp4");
    expect(signer.verify(key, exp, sig)).toBe(true);
  });

  it("rejects tampered keys, signatures, expiries and other secrets", () => {
    const { key, exp, sig } = parts(signer.sign("ws_a/file.png", 60));
    expect(signer.verify("ws_b/file.png", exp, sig)).toBe(false);
    expect(signer.verify(key, String(Number(exp) + 1), sig)).toBe(false);
    expect(signer.verify(key, exp, `${sig.slice(0, -2)}AA`)).toBe(false);
    expect(signer.verify(key, undefined, sig)).toBe(false);
    expect(new ArtifactSigner("another-secret-0123456789", BASE).verify(key, exp, sig)).toBe(false);
  });

  it("rejects expired URLs", () => {
    const past = new ArtifactSigner("secret-for-tests-0123456789", BASE, () => Date.now() - 3_600_000);
    const { key, exp, sig } = parts(past.sign("ws_a/file.png", 60));
    expect(signer.verify(key, exp, sig)).toBe(false);
  });

  it("refuses unsafe keys", () => {
    expect(() => signer.sign("../etc/passwd")).toThrow(MotionError);
    expect(signer.verify("../etc/passwd", "9999999999", "x")).toBe(false);
  });

  it("derives a stable secret from MOTION_API_KEYS and falls back to the dev secret outside production", () => {
    const a = resolveSigningSecret({ MOTION_API_KEYS: "k1", NODE_ENV: "production" });
    expect(a).toBe(resolveSigningSecret({ MOTION_API_KEYS: "k1", NODE_ENV: "production" }));
    expect(a).not.toContain("k1");
    expect(resolveSigningSecret({ MOTION_API_KEYS: "", NODE_ENV: "development" })).toBe(
      resolveSigningSecret({ MOTION_API_KEYS: "", NODE_ENV: "test" }),
    );
    const prodA = resolveSigningSecret({ MOTION_API_KEYS: "", NODE_ENV: "production" });
    expect(prodA).not.toBe(resolveSigningSecret({ MOTION_API_KEYS: "", NODE_ENV: "production" }));
  });
});

describe("billing guard", () => {
  it("grants the trial once per workspace, across instances", async () => {
    const ledger = new CreditLedger(new InMemoryLedgerStore());
    await new TrialGrants(ledger, 500).ensure("ws_1");
    await new TrialGrants(ledger, 500).ensure("ws_1");
    const grants = new TrialGrants(ledger, 500);
    await Promise.all([grants.ensure("ws_1"), grants.ensure("ws_2")]);
    expect((await ledger.balance("ws_1")).available).toBe(500);
    expect((await ledger.balance("ws_2")).available).toBe(500);
  });

  it("maps an unaffordable reservation to INSUFFICIENT_CREDITS and a low budget to BUDGET_EXCEEDED", async () => {
    const ledger = new CreditLedger(new InMemoryLedgerStore());
    const quote = quoteJob({ durationSeconds: 6, directorMode: "host-opus", critiqueLoops: 0, previews: 1 });
    await expect(reserveForJob(ledger, { workspaceId: "ws_1", jobId: "job_1", quote })).rejects.toMatchObject(
      {
        code: "INSUFFICIENT_CREDITS",
      },
    );
    await expect(
      reserveForJob(ledger, { workspaceId: "ws_1", jobId: "job_2", quote, budgetCredits: 1 }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await new TrialGrants(ledger, 500).ensure("ws_1");
    const r = await reserveForJob(ledger, { workspaceId: "ws_1", jobId: "job_3", quote });
    expect(r.credits).toBe(quote.totalCredits);
    expect((await ledger.balance("ws_1")).held).toBe(quote.totalCredits);
  });
});

describe("JobQueue", () => {
  it("runs one job at a time in order and aborts pending jobs on close", async () => {
    const queue = new JobQueue(1);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    queue.enqueue("a", async () => {
      order.push("a:start");
      await gate;
      order.push("a:end");
    });
    queue.enqueue("b", async () => {
      order.push("b");
    });
    expect(() => queue.enqueue("a", async () => undefined)).toThrow(MotionError);
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["a:start"]);
    release();
    await queue.settled("b");
    expect(order).toEqual(["a:start", "a:end", "b"]);

    let aborted = false;
    queue.enqueue("c", (signal) => new Promise<void>((r) => signal.addEventListener("abort", () => r())));
    queue.enqueue("d", async (signal) => {
      aborted = signal.aborted;
    });
    await queue.close(20);
    expect(aborted).toBe(true);
    expect(() => queue.enqueue("e", async () => undefined)).toThrow(MotionError);
  });
});

describe("bm25Search", () => {
  const docs = [
    {
      type: "project" as const,
      id: "p1",
      title: "Tracewise launch",
      text: "distributed tracing launch video",
    },
    { type: "project" as const, id: "p2", title: "Quarterly report", text: "finance numbers and charts" },
    { type: "style" as const, id: "swiss", title: "Swiss editorial", text: "grid typography calm" },
  ];

  it("ranks by relevance, flags exact title matches and filters empty queries", () => {
    const out = bm25Search(docs, "tracewise launch", 5);
    expect(out.results[0]?.id).toBe("p1");
    expect(out.exact).toBe(true);
    expect(bm25Search(docs, "typography", 5)).toMatchObject({ exact: false, results: [{ id: "swiss" }] });
    expect(bm25Search(docs, "!!", 5).results).toEqual([]);
  });
});
