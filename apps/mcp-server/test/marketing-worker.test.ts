import { describe, expect, it } from "vitest";
import { type Env, handleRequest } from "../../marketing/src/worker.ts";

const assetsHits: string[] = [];
const env: Env = {
  APP_ORIGIN: "https://app.motion.digitop.ai",
  ASSETS: {
    async fetch(request: Request) {
      assetsHits.push(new URL(request.url).pathname);
      return new Response("asset", { status: 200 });
    },
  },
};

describe("marketing Worker", () => {
  it("redirects auth routes to the app with path and query intact", async () => {
    const res = await handleRequest(
      new Request("https://motion.digitop.ai/api/auth/oauth/github/callback?code=abc&state=xyz"),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.motion.digitop.ai/api/auth/oauth/github/callback?code=abc&state=xyz",
    );
  });

  it("proxies the Polar webhook with method, signature headers and raw body", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return Response.json({ ok: true, handled: true }, { status: 200 });
    }) as typeof fetch;
    const body = '{"type":"order.paid","data":{}}';
    const res = await handleRequest(
      new Request("https://motion.digitop.ai/api/webhooks/polar", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": "msg_1",
          "webhook-timestamp": "1700000000",
          "webhook-signature": "v1,abc",
        },
        body,
      }),
      env,
      upstream,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: true });
    expect(seen[0]?.url).toBe("https://app.motion.digitop.ai/webhooks/polar");
    expect(seen[0]?.init?.method).toBe("POST");
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get("webhook-signature")).toBe("v1,abc");
    expect(headers.get("host")).toBeNull();
    expect(new TextDecoder().decode(seen[0]?.init?.body as ArrayBuffer)).toBe(body);
  });

  it("returns 404 for other /api paths and serves assets for everything else", async () => {
    const api = await handleRequest(new Request("https://motion.digitop.ai/api/other"), env);
    expect(api.status).toBe(404);
    const post = await handleRequest(
      new Request("https://motion.digitop.ai/api/auth/email/request", { method: "POST", body: "{}" }),
      env,
    );
    expect(post.status).toBe(404);
    const page = await handleRequest(new Request("https://motion.digitop.ai/pricing"), env);
    expect(await page.text()).toBe("asset");
    expect(assetsHits).toEqual(["/pricing"]);
  });
});
