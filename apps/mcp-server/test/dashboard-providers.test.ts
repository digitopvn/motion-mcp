import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthInteraction } from "@motion-mcp/pi-runtime";
import { SealedBox } from "@motion-mcp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiLogins } from "../src/dashboard-providers.ts";
import { GITHUB_TOKEN_URL } from "../src/github-oauth.ts";
import { type Harness, startHarness } from "./harness.ts";

const ORIGIN = "http://127.0.0.1:8787";
const ENCRYPTION_KEY = "5f".repeat(32);
const PI_KEY = "sk-or-v1-provider-test-key-7a3c";
const MULTIX_KEY = "gemini-provider-test-key-91e4";

let githubId = 500;
const mockFetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === GITHUB_TOKEN_URL) return Response.json({ access_token: "gho_providertest0123456789" });
  if (url === "https://api.github.com/user") {
    const id = githubId;
    return Response.json({
      id,
      login: `user${id}`,
      name: `User ${id}`,
      avatar_url: "https://example.com/a.png",
    });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: `user${githubId}@example.com`, primary: true, verified: true }]);
  }
  return new Response("unexpected outbound call", { status: 500 });
}) as typeof fetch;

let h: Harness;

beforeAll(async () => {
  h = await startHarness(
    {
      GITHUB_CLIENT_ID: "Iv1.testclient",
      GITHUB_CLIENT_SECRET: "test-github-client-secret-0123456789",
      CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY,
      IMPLEMENTATION_MODE: "pi",
    },
    {},
    { fetch: mockFetch },
  );
});

afterAll(async () => {
  await h?.close();
});

function request(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return fetch(new URL(path, h.base), { ...init, headers, redirect: "manual" });
}

function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return request(path, {
    method,
    cookie,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signIn(id: number): Promise<{ cookie: string; workspaceId: string }> {
  githubId = id;
  const start = await request("/api/auth/oauth/github/start");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const oauth = /mmcp_oauth=([^;]+)/.exec(start.headers.getSetCookie().join("\n"))?.[1] ?? "";
  const cb = await request(`/api/auth/oauth/github/callback?code=good&state=${state}`, {
    cookie: `mmcp_oauth=${oauth}`,
  });
  const session = /mmcp_session=([^;]+)/.exec(cb.headers.getSetCookie().join("\n"))?.[1];
  if (!session) throw new Error("sign-in failed");
  const cookie = `mmcp_session=${session}`;
  const me = (await (await request("/api/me", { cookie })).json()) as { workspace: { id: string } };
  return { cookie, workspaceId: me.workspace.id };
}

interface LoginView {
  id: string;
  status: string;
  prompt: { id: string; type: string; message: string } | null;
  error: string | null;
}

async function pollLogin(cookie: string, id: string, until: (l: LoginView) => boolean): Promise<LoginView> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await request(`/api/providers/pi/logins/${id}`, { cookie });
    const { login } = (await res.json()) as { login: LoginView };
    if (until(login)) return login;
    if (Date.now() > deadline) throw new Error(`login stuck: ${JSON.stringify(login)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function allStoredText(): Promise<string> {
  const dir = join(h.dataDir, "db");
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out.push(await readFile(p, "utf8"));
    }
  };
  await walk(dir);
  return out.join("\n");
}

describe("workspace providers API", () => {
  let owner: { cookie: string; workspaceId: string };
  let other: { cookie: string; workspaceId: string };

  beforeAll(async () => {
    owner = await signIn(501);
    other = await signIn(502);
  });

  it("requires a session and a same-origin mutation", async () => {
    expect((await request("/api/providers")).status).toBe(401);
    const res = await request(`/api/providers/multix/GEMINI_API_KEY`, {
      method: "PUT",
      cookie: owner.cookie,
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ value: MULTIX_KEY }),
    });
    expect(res.status).toBe(403);
  });

  it("lists pi providers with both sign-in methods and every multix key", async () => {
    const res = await request("/api/providers", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      pi: { providers: Array<{ id: string; oauth: unknown; apiKey: unknown; connected: unknown }> };
      multix: { keys: Array<{ name: string; set: boolean }> };
    };
    expect(body.enabled).toBe(true);
    const anthropic = body.pi.providers.find((p) => p.id === "anthropic");
    expect(anthropic?.oauth).toMatchObject({ name: "Anthropic (Claude Pro/Max)" });
    expect(anthropic?.apiKey).toMatchObject({ name: "Anthropic API key" });
    expect(body.pi.providers.find((p) => p.id === "openai-codex")?.apiKey).toBeNull();
    expect(body.multix.keys.map((k) => k.name)).toContain("GEMINI_API_KEY");
    expect(body.multix.keys.every((k) => !k.set)).toBe(true);
  });

  it("connects a pi provider by API key, selects a model and routes jobs to it", async () => {
    const start = await send("POST", "/api/providers/pi/logins", owner.cookie, {
      provider: "openrouter",
      type: "api_key",
    });
    expect(start.status).toBe(201);
    const { login } = (await start.json()) as { login: LoginView };
    const waiting = await pollLogin(owner.cookie, login.id, (l) => l.status === "waiting");
    expect(waiting.prompt).toMatchObject({ type: "secret" });

    // Another workspace cannot see or answer this login.
    expect((await request(`/api/providers/pi/logins/${login.id}`, { cookie: other.cookie })).status).toBe(
      404,
    );

    const stale = await send("POST", `/api/providers/pi/logins/${login.id}/respond`, owner.cookie, {
      promptId: "prompt_stale",
      value: PI_KEY,
    });
    expect(stale.status).toBe(409);
    const answer = await send("POST", `/api/providers/pi/logins/${login.id}/respond`, owner.cookie, {
      promptId: waiting.prompt?.id,
      value: PI_KEY,
    });
    expect(answer.status).toBe(200);
    expect(await answer.text()).not.toContain(PI_KEY);
    await pollLogin(owner.cookie, login.id, (l) => l.status === "succeeded");

    const overview = await request("/api/providers", { cookie: owner.cookie });
    const text = await overview.text();
    expect(text).not.toContain(PI_KEY);
    const body = JSON.parse(text) as {
      pi: {
        providers: Array<{ id: string; connected: { authType: string; hint: string } | null }>;
        models: Record<string, Array<{ id: string }>>;
      };
    };
    expect(body.pi.providers.find((p) => p.id === "openrouter")?.connected).toMatchObject({
      authType: "api_key",
      hint: "7a3c",
    });
    const model = body.pi.models.openrouter?.[0]?.id ?? "";
    expect(model).not.toBe("");

    expect(
      (
        await send("PUT", "/api/providers/pi/model", owner.cookie, {
          provider: "openrouter",
          model: "nope/none",
        })
      ).status,
    ).toBe(400);
    expect(
      (await send("PUT", "/api/providers/pi/model", other.cookie, { provider: "openrouter", model })).status,
    ).toBe(400);
    const select = await send("PUT", "/api/providers/pi/model", owner.cookie, {
      provider: "openrouter",
      model,
    });
    expect(select.status).toBe(200);

    const worker = await h.rt.providers.sceneWorkerFor(owner.workspaceId);
    expect(worker?.name).toBe("pi");
    expect(await h.rt.providers.sceneWorkerFor(other.workspaceId)).toBeUndefined();

    // Stored at rest only as ciphertext bound to this workspace.
    expect(await allStoredText()).not.toContain(PI_KEY);
    const record = await h.rt.repos.providerCredentials.get(owner.workspaceId, "pi", "openrouter");
    const box = new SealedBox(ENCRYPTION_KEY);
    expect(() => box.open(record!, `${other.workspaceId}:pi:openrouter`)).toThrow();

    const disconnect = await send("DELETE", "/api/providers/pi/openrouter", owner.cookie);
    expect(disconnect.status).toBe(204);
    expect(await h.rt.repos.providerCredentials.get(owner.workspaceId, "pi", "openrouter")).toBeUndefined();
    expect((await h.rt.repos.workspaces.get(owner.workspaceId))?.piModel).toBeUndefined();
    expect(await h.rt.providers.sceneWorkerFor(owner.workspaceId)).toBeUndefined();
  });

  it("stores, isolates and removes multix keys", async () => {
    expect(
      (await send("PUT", "/api/providers/multix/NOT_A_KEY", owner.cookie, { value: MULTIX_KEY })).status,
    ).toBe(404);
    const put = await send("PUT", "/api/providers/multix/GEMINI_API_KEY", owner.cookie, {
      value: MULTIX_KEY,
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(MULTIX_KEY);
    expect(JSON.parse(putText)).toMatchObject({ key: { name: "GEMINI_API_KEY", set: true, hint: "91e4" } });

    expect(await h.rt.providers.multixEnv(owner.workspaceId)).toEqual({ GEMINI_API_KEY: MULTIX_KEY });
    expect(await h.rt.providers.multixEnv(other.workspaceId)).toEqual({});
    expect(await allStoredText()).not.toContain(MULTIX_KEY);

    expect((await send("DELETE", "/api/providers/multix/GEMINI_API_KEY", other.cookie)).status).toBe(404);
    expect((await send("DELETE", "/api/providers/multix/GEMINI_API_KEY", owner.cookie)).status).toBe(204);
    expect(await h.rt.providers.multixEnv(owner.workspaceId)).toEqual({});
  });
});

describe("pi login relay", () => {
  /** A stand-in for pi's OAuth flow: shows a URL, races a pasted code against a callback. */
  function fakeOAuth(result: { code?: string }) {
    return {
      async login(_provider: string, _type: string, i: AuthInteraction) {
        i.notify({ type: "auth_url", url: "https://auth.example/authorize?state=s1" });
        const callback = new AbortController();
        const pasted = i.prompt({
          type: "manual_code",
          message: "Paste the redirect URL",
          signal: callback.signal,
        });
        result.code = await pasted;
        return { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
      },
    };
  }

  it("relays events and prompts, and accepts one answer per prompt", async () => {
    const logins = new PiLogins();
    const result: { code?: string } = {};
    const s = logins.start(fakeOAuth(result) as never, "ws_a", "anthropic", "oauth");
    await new Promise((r) => setImmediate(r));
    expect(s.events).toEqual([{ type: "auth_url", url: "https://auth.example/authorize?state=s1" }]);
    expect(s.status).toBe("waiting");
    expect(s.prompt?.type).toBe("manual_code");
    expect(() => logins.get(s.id, "ws_b")).toThrow("Login not found");

    // A second OAuth sign-in with the same provider elsewhere would fight over the callback port.
    expect(() => logins.start(fakeOAuth({}) as never, "ws_b", "anthropic", "oauth")).toThrow(/in progress/);

    logins.respond(s, s.prompt?.id ?? "", "http://localhost:53692/callback?code=c1");
    expect(() => logins.respond(s, "prompt_x", "again")).toThrow(/no longer waiting/);
    await new Promise((r) => setImmediate(r));
    expect(result.code).toBe("http://localhost:53692/callback?code=c1");
    expect(s.status).toBe("succeeded");
  });

  it("cancels a waiting login and rejects pi's pending prompt", async () => {
    const logins = new PiLogins();
    let rejected = false;
    const s = logins.start(
      {
        async login(_p: string, _t: string, i: AuthInteraction) {
          try {
            await i.prompt({ type: "secret", message: "key" });
          } catch {
            rejected = true;
          }
          throw new Error("aborted");
        },
      } as never,
      "ws_a",
      "openrouter",
      "api_key",
    );
    await new Promise((r) => setImmediate(r));
    logins.cancel(s);
    await new Promise((r) => setImmediate(r));
    expect(rejected).toBe(true);
    expect(s.status).toBe("cancelled");
    expect(s.controller.signal.aborted).toBe(true);
  });
});
