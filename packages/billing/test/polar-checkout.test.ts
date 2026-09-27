import { describe, expect, it } from "vitest";
import { CreditLedger, createPolarCheckout, InMemoryLedgerStore } from "../src/index.ts";

describe("createPolarCheckout", () => {
  it("posts the product and workspace metadata and returns the hosted URL", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return Response.json({ id: "chk_1", url: "https://sandbox.polar.sh/checkout/chk_1" }, { status: 201 });
    }) as typeof fetch;

    const out = await createPolarCheckout({
      accessToken: "polar_oat_test_token_value",
      environment: "sandbox",
      productId: "prod_123",
      workspaceId: "ws_abc",
      successUrl: "https://app.example.com/billing?checkout=success",
      fetch: fakeFetch,
    });
    expect(out).toEqual({ id: "chk_1", url: "https://sandbox.polar.sh/checkout/chk_1" });
    expect(seen[0]?.url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    const body = JSON.parse(String(seen[0]?.init?.body));
    expect(body).toMatchObject({
      products: ["prod_123"],
      external_customer_id: "ws_abc",
      metadata: { workspace_id: "ws_abc" },
    });
  });

  it("maps HTTP failures and malformed responses to PROVIDER errors", async () => {
    const failing = (async () => new Response("nope", { status: 422 })) as typeof fetch;
    const base = {
      accessToken: "polar_oat_test_token_value",
      environment: "production" as const,
      productId: "prod_123",
      workspaceId: "ws_abc",
      successUrl: "https://app.example.com/billing",
    };
    await expect(createPolarCheckout({ ...base, fetch: failing })).rejects.toMatchObject({
      code: "PROVIDER",
    });
    const malformed = (async () => Response.json({ id: "x" })) as typeof fetch;
    await expect(createPolarCheckout({ ...base, fetch: malformed })).rejects.toMatchObject({
      code: "PROVIDER",
    });
  });
});

describe("CreditLedger.transactions", () => {
  it("returns only the workspace's transactions in order", async () => {
    const ledger = new CreditLedger(new InMemoryLedgerStore());
    await ledger.grant({ workspaceId: "ws_1", credits: 10, source: "trial", idempotencyKey: "t1" });
    await ledger.grant({ workspaceId: "ws_2", credits: 5, source: "trial", idempotencyKey: "t2" });
    await ledger.reserve({ workspaceId: "ws_1", credits: 3 });
    const txs = await ledger.transactions("ws_1");
    expect(txs.map((t) => t.kind)).toEqual(["grant", "reserve"]);
  });
});
