import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, githubStartUrl, loginPath, safeNext } from "../src/lib/api.ts";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("safeNext / loginPath", () => {
  it("keeps same-origin paths with their query", () => {
    expect(safeNext("/videos/p_1?tab=traces")).toBe("/videos/p_1?tab=traces");
    expect(loginPath("/videos/p_1?tab=traces")).toBe("/login?next=%2Fvideos%2Fp_1%3Ftab%3Dtraces");
  });

  it("rejects anything that could leave the origin or loop to login", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/login",
      "/login?next=/x",
      "/ok\nLocation: x",
    ]) {
      expect(safeNext(raw)).toBe("/");
    }
  });

  it("omits next for the root path", () => {
    expect(loginPath("/")).toBe("/login");
    expect(loginPath("https://evil.example")).toBe("/login");
  });

  it("builds the GitHub start URL with an encoded next", () => {
    expect(githubStartUrl("/keys")).toBe("/api/auth/oauth/github/start?next=%2Fkeys");
    expect(githubStartUrl("//evil")).toBe("/api/auth/oauth/github/start?next=%2F");
  });
});

describe("createApiClient", () => {
  it("returns parsed JSON and sends JSON bodies", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    const client = createApiClient({ fetch: fetchMock, onUnauthorized: vi.fn() });

    await expect(client.post("/api/keys", { name: "cli" })).resolves.toEqual({ ok: true });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/keys");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "cli" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
  });

  it("calls onUnauthorized and rejects with a 401 ApiError", async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      fetch: async () => jsonResponse(401, { error: "unauthorized" }),
      onUnauthorized,
    });

    const error = await client.get("/api/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("skips the redirect handler when a 401 is expected", async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient({ fetch: async () => jsonResponse(401), onUnauthorized });

    await expect(client.get("/api/me", { allowUnauthorized: true })).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("maps error bodies to code and message", async () => {
    const client = createApiClient({
      fetch: async () => jsonResponse(402, { error: "insufficient_credits", message: "Not enough credits" }),
      onUnauthorized: vi.fn(),
    });

    await expect(client.post("/api/projects", {})).rejects.toMatchObject({
      status: 402,
      code: "insufficient_credits",
      message: "Not enough credits",
    });
  });

  it("resolves undefined for 204 and reports network failures", async () => {
    const ok = createApiClient({
      fetch: async () => new Response(null, { status: 204 }),
      onUnauthorized: vi.fn(),
    });
    await expect(ok.del("/api/keys/k1")).resolves.toBeUndefined();

    const down = createApiClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      onUnauthorized: vi.fn(),
    });
    await expect(down.get("/api/me")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });
});
