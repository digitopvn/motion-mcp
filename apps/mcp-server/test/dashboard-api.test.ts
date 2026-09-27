import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeNext } from "../src/dashboard-http.ts";
import { RESEND_EMAILS_URL } from "../src/email-login.ts";
import { GITHUB_TOKEN_URL } from "../src/github-oauth.ts";
import { type Harness, startHarness } from "./harness.ts";

const ORIGIN = "http://127.0.0.1:8787";
const INDEX_HTML = "<!doctype html><html><body><div id=root></div>dashboard-shell</body></html>";

interface GithubUserFixture {
  id: number;
  login: string;
  name: string;
  avatar_url: string;
}

let githubUser: GithubUserFixture = {
  id: 101,
  login: "octo",
  name: "Octo Cat",
  avatar_url: "https://avatars.githubusercontent.com/u/101",
};
const outbound: Array<{ url: string; body?: string }> = [];

/** Stands in for GitHub and Resend; no test reaches the network. */
const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const body = typeof init?.body === "string" ? init.body : undefined;
  outbound.push({ url, body });
  if (url === GITHUB_TOKEN_URL) {
    const { code } = JSON.parse(body ?? "{}") as { code?: string };
    return code === "good-code"
      ? Response.json({ access_token: "gho_testaccesstoken0123456789" })
      : Response.json({ error: "bad_verification_code" });
  }
  if (url === "https://api.github.com/user") return Response.json(githubUser);
  if (url === "https://api.github.com/user/emails") {
    return Response.json([
      { email: `${githubUser.login}@users.noreply.github.com`, primary: false, verified: true },
      { email: `${githubUser.login}@example.com`, primary: true, verified: true },
    ]);
  }
  if (url === RESEND_EMAILS_URL) return Response.json({ id: "email_1" });
  return new Response("unexpected outbound call", { status: 500 });
}) as typeof fetch;

let h: Harness;
let distDir: string;

beforeAll(async () => {
  distDir = await mkdtemp(join(tmpdir(), "dashboard-dist-"));
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, "index.html"), INDEX_HTML);
  await writeFile(join(distDir, "assets", "app-abc123.js"), "console.log('app')");
  h = await startHarness(
    {
      GITHUB_CLIENT_ID: "Iv1.testclient",
      GITHUB_CLIENT_SECRET: "test-github-client-secret-0123456789",
      RESEND_API_KEY: "re_test_resend_key_0123456789",
      EMAIL_FROM: "Motion MCP <login@example.com>",
      DASHBOARD_DIST: distDir,
      TRIAL_CREDITS: "500",
    },
    {},
    { fetch: mockFetch },
  );
});

afterAll(async () => {
  await h?.close();
  await rm(distDir, { recursive: true, force: true });
});

function request(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return fetch(new URL(path, h.base), { ...init, headers, redirect: "manual" });
}

/** Mutating call from the dashboard origin with a JSON body. */
function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return request(path, {
    method,
    cookie,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieValue(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0 && pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return undefined;
}

async function githubLogin(next = "/videos"): Promise<{ cookie: string; location: string | null }> {
  const start = await request(`/api/auth/oauth/github/start?next=${encodeURIComponent(next)}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(`${authorize.origin}${authorize.pathname}`).toBe("https://github.com/login/oauth/authorize");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "https://motion.digitop.ai/api/auth/oauth/github/callback",
  );
  expect(authorize.searchParams.get("scope")).toBe("read:user user:email");
  const state = authorize.searchParams.get("state") ?? "";
  const oauth = cookieValue(start, "mmcp_oauth");
  expect(oauth).toBeTruthy();
  const cb = await request(`/api/auth/oauth/github/callback?code=good-code&state=${state}`, {
    cookie: `mmcp_oauth=${oauth}`,
  });
  expect(cb.status).toBe(302);
  const session = cookieValue(cb, "mmcp_session");
  expect(session).toBeTruthy();
  expect(cb.headers.getSetCookie().join("\n")).toMatch(
    /mmcp_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax/,
  );
  return { cookie: `mmcp_session=${session}`, location: cb.headers.get("location") };
}

describe("dashboard auth", () => {
  it("reports enabled providers", async () => {
    const res = await request("/api/auth/providers");
    expect(await res.json()).toEqual({ github: true, email: true });
  });

  it("GitHub callback creates the user, workspace, trial credits and a session", async () => {
    expect((await request("/api/me")).status).toBe(401);
    const { cookie, location } = await githubLogin("/videos?tab=all");
    expect(location).toBe("/videos?tab=all");

    const me = await request("/api/me", { cookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      user: { id: string; name: string; email: string; avatarUrl: string };
      workspace: { id: string };
      credits: { balance: number; held: number };
    };
    expect(body.user).toMatchObject({
      name: "Octo Cat",
      email: "octo@example.com",
      avatarUrl: "https://avatars.githubusercontent.com/u/101",
    });
    expect(body.workspace.id).toMatch(/^ws_/);
    expect(body.credits).toEqual({ balance: 500, held: 0 });

    // A second login reuses the same account and never grants the trial twice.
    const again = await githubLogin();
    const me2 = (await (await request("/api/me", { cookie: again.cookie })).json()) as typeof body;
    expect(me2.user.id).toBe(body.user.id);
    expect(me2.workspace.id).toBe(body.workspace.id);
    expect(me2.credits.balance).toBe(500);
    expect(await h.rt.repos.workspaces.listByOwner(body.user.id)).toHaveLength(1);
  });

  it("rejects a callback whose state does not match the state cookie", async () => {
    const start = await request("/api/auth/oauth/github/start");
    const oauth = cookieValue(start, "mmcp_oauth");
    const forged = await request("/api/auth/oauth/github/callback?code=good-code&state=forged", {
      cookie: `mmcp_oauth=${oauth}`,
    });
    expect(forged.status).toBe(302);
    expect(forged.headers.get("location")).toBe("/login?error=state_mismatch");
    expect(cookieValue(forged, "mmcp_session")).toBeUndefined();

    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const noCookie = await request(`/api/auth/oauth/github/callback?code=good-code&state=${state}`);
    expect(noCookie.headers.get("location")).toBe("/login?error=state_mismatch");
  });

  it("fails closed when GitHub rejects the code", async () => {
    const start = await request("/api/auth/oauth/github/start");
    const oauth = cookieValue(start, "mmcp_oauth");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const res = await request(`/api/auth/oauth/github/callback?code=bad-code&state=${state}`, {
      cookie: `mmcp_oauth=${oauth}`,
    });
    expect(res.headers.get("location")).toBe("/login?error=oauth_failed");
    expect(cookieValue(res, "mmcp_session")).toBeUndefined();
  });

  it("only redirects to same-origin relative paths after login", async () => {
    expect((await githubLogin("//evil.example.com/x")).location).toBe("/");
    expect((await githubLogin("https://evil.example.com/")).location).toBe("/");
    const base = "https://app.motion.digitop.ai";
    expect(sanitizeNext("/keys?x=1#top", base)).toBe("/keys?x=1#top");
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "/a\nb",
      "",
      42,
    ]) {
      expect(sanitizeNext(bad, base)).toBe("/");
    }
  });

  it("signs in with a single-use email link", async () => {
    const before = outbound.length;
    const res = await send("POST", "/api/auth/email/request", "", {
      email: "Mail@Example.com",
      next: "/recipes",
    });
    expect(res.status).toBe(204);
    let sent: { url: string; body?: string } | undefined;
    for (let i = 0; i < 50 && !sent; i++) {
      sent = outbound.slice(before).find((o) => o.url === RESEND_EMAILS_URL);
      if (!sent) await new Promise((r) => setTimeout(r, 20));
    }
    const payload = JSON.parse(sent?.body ?? "{}") as { to: string[]; text: string };
    expect(payload.to).toEqual(["mail@example.com"]);
    const link = new URL(/https?:\/\/\S+/.exec(payload.text)?.[0] ?? "");
    const verify = await request(`${link.pathname}${link.search}`);
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe("/recipes");
    const cookie = `mmcp_session=${cookieValue(verify, "mmcp_session")}`;
    expect((await request("/api/me", { cookie })).status).toBe(200);

    const replay = await request(`${link.pathname}${link.search}`);
    expect(replay.headers.get("location")).toBe("/login?error=link_invalid");

    expect((await send("POST", "/api/auth/email/request", "", { email: "nope" })).status).toBe(400);
  });

  it("logout deletes the session", async () => {
    const { cookie } = await githubLogin();
    const out = await send("POST", "/api/auth/logout", cookie);
    expect(out.status).toBe(204);
    expect((await request("/api/me", { cookie })).status).toBe(401);
  });
});

describe("dashboard API", () => {
  it("rejects mutating requests from another origin or without an Origin header", async () => {
    const { cookie } = await githubLogin();
    const evil = await request("/api/keys", {
      method: "POST",
      cookie,
      headers: { origin: "https://evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: "forbidden" });
    const missing = await request("/api/keys", {
      method: "POST",
      cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(missing.status).toBe(403);
    const listed = (await (await request("/api/keys", { cookie })).json()) as { keys: unknown[] };
    expect(listed.keys).toHaveLength(0);
  });

  it("a created key authenticates /mcp until it is revoked", async () => {
    const { cookie } = await githubLogin();
    const created = await send("POST", "/api/keys", cookie, { name: "laptop" });
    expect(created.status).toBe(201);
    const { key, secret } = (await created.json()) as { key: { id: string; prefix: string }; secret: string };
    expect(secret.startsWith(key.prefix)).toBe(true);

    const listed = (await (await request("/api/keys", { cookie })).json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(listed.keys.find((k) => k.id === key.id)).toMatchObject({ name: "laptop", prefix: key.prefix });
    expect(JSON.stringify(listed)).not.toContain(secret);

    const client = await h.connect(secret);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(8);

    expect((await send("DELETE", `/api/keys/${key.id}`, cookie)).status).toBe(204);
    const raw = await fetch(new URL("/mcp", h.base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(raw.status).toBe(401);
    await expect(h.connect(secret)).rejects.toThrow();
  });

  it("scopes recipes to the caller's workspace", async () => {
    githubUser = {
      id: 101,
      login: "octo",
      name: "Octo Cat",
      avatar_url: "https://avatars.githubusercontent.com/u/101",
    };
    const a = await githubLogin();
    githubUser = {
      id: 202,
      login: "other",
      name: "Other User",
      avatar_url: "https://avatars.githubusercontent.com/u/202",
    };
    const b = await githubLogin();

    const created = await send("POST", "/api/recipes", a.cookie, {
      name: "Launch teaser",
      brief: "A 20 second launch teaser",
      format: { aspectRatio: "9:16" },
      durationSeconds: 20,
      quality: "preview",
    });
    expect(created.status).toBe(201);
    const { recipe } = (await created.json()) as { recipe: { id: string } };

    const patched = await send("PATCH", `/api/recipes/${recipe.id}`, a.cookie, {
      notes: "upbeat",
      durationSeconds: null,
    });
    const patchedBody = (await patched.json()) as { recipe: Record<string, unknown> };
    expect(patchedBody.recipe).toMatchObject({ notes: "upbeat", name: "Launch teaser" });
    expect(patchedBody.recipe.durationSeconds).toBeUndefined();

    expect(
      ((await (await request("/api/recipes", { cookie: a.cookie })).json()) as { recipes: unknown[] })
        .recipes,
    ).toHaveLength(1);
    expect(
      ((await (await request("/api/recipes", { cookie: b.cookie })).json()) as { recipes: unknown[] })
        .recipes,
    ).toHaveLength(0);

    for (const res of [
      await request(`/api/recipes/${recipe.id}`, { cookie: b.cookie }),
      await send("PATCH", `/api/recipes/${recipe.id}`, b.cookie, { name: "stolen" }),
      await send("DELETE", `/api/recipes/${recipe.id}`, b.cookie),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not_found" });
    }
    expect((await send("POST", "/api/recipes", a.cookie, { name: "", brief: "x" })).status).toBe(400);
    expect((await send("DELETE", `/api/recipes/${recipe.id}`, a.cookie)).status).toBe(204);
    expect((await request(`/api/recipes/${recipe.id}`, { cookie: a.cookie })).status).toBe(404);
  });

  it("maps service errors to public codes", async () => {
    const { cookie } = await githubLogin();
    const invalid = await send("POST", "/api/projects", cookie, { brief: "x" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_input" });
    const missing = await request("/api/projects/prj_missing", { cookie });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
    const list = await request("/api/projects", { cookie });
    expect(await list.json()).toEqual({ projects: [] });
    const overview = await request("/api/overview", { cookie });
    expect(await overview.json()).toMatchObject({
      trialCredits: 500,
      projectCount: 0,
      recentProjects: [],
      usage: { credits: 0, events: 0 },
    });
    const badJson = await request("/api/recipes", {
      method: "POST",
      cookie,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    const billing = (await (await request("/api/billing", { cookie })).json()) as {
      checkout: { enabled: boolean };
    };
    expect(billing.checkout.enabled).toBe(false);
    expect(await (await send("POST", "/api/billing/checkout", cookie)).json()).toEqual({ enabled: false });
    const usage = await request("/api/usage?since=2026-01-01T00:00:00Z", { cookie });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ totals: { credits: 0 }, events: [] });
  });
});

describe("dashboard static serving", () => {
  it("serves the SPA shell with security headers and long-cached assets", async () => {
    const root = await request("/", { headers: { accept: "text/html" } });
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("dashboard-shell");
    expect(root.headers.get("cache-control")).toBe("no-cache");
    const csp = root.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://avatars.githubusercontent.com");

    const deep = await request("/videos/prj_123", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(await deep.text()).toContain("dashboard-shell");

    const asset = await request("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("never shadows server routes", async () => {
    const html = { accept: "text/html" };
    const mcp = await request("/mcp", { headers: html });
    expect(mcp.status).toBe(401);
    expect(await mcp.text()).not.toContain("dashboard-shell");
    const api = await request("/api/nope", { headers: html });
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ error: "not_found" });
    const health = await request("/healthz", { headers: html });
    expect(await health.json()).toMatchObject({ ok: true });
    const video = await request("/v/rnd_missing0000", { headers: html });
    expect(await video.text()).not.toContain("dashboard-shell");
    const artifact = await request("/artifacts/x.mp4", { headers: html });
    expect(artifact.status).toBe(403);
  });
});

describe("dashboard without a build", () => {
  it("answers / with a 503 note", async () => {
    const bare = await startHarness(
      { DASHBOARD_DIST: join(tmpdir(), "motion-no-dashboard-build") },
      {},
      { fetch: mockFetch },
    );
    try {
      const res = await fetch(new URL("/", bare.base), { headers: { accept: "*/*" } });
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("Dashboard unavailable");
      const providers = await fetch(new URL("/api/auth/providers", bare.base));
      expect(await providers.json()).toEqual({ github: false, email: false });
    } finally {
      await bare.close();
    }
  });
});
