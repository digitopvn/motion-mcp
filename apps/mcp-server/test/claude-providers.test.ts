import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHyperframesAdapter } from "@motion-mcp/hyperframes-adapter";
import { ScriptedGateway } from "@motion-mcp/llm";
import { AUTH_REJECTED, MotionError } from "@motion-mcp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GITHUB_TOKEN_URL } from "../src/github-oauth.ts";
import { call, callOk, type Harness, startHarness, waitForJob } from "./harness.ts";

const ORIGIN = "http://127.0.0.1:8787";
const ENCRYPTION_KEY = "6a".repeat(32);
const GOOD_KEY = "sk-ant-api03-claude-provider-test-key-good-0123456789";
const REJECTED_KEY = "sk-ant-api03-claude-provider-test-key-revoked-987654";
const AMBIENT_KEY = "sk-ant-api03-ambient-server-key-must-never-be-used-00";
const SPEC_JSON = readFileSync(
  resolve(import.meta.dirname, "../../../fixtures/golden/product-launch/creative-spec.json"),
  "utf8",
);

const doctor = await createHyperframesAdapter().doctor({ ensureBrowser: false });
const canRender = doctor.hyperframes.ok && doctor.chrome.ok && doctor.ffmpeg.ok;

/** Keys the fake Anthropic API rejects; flipping one simulates a key revoked after it was stored. */
const rejected = new Set([REJECTED_KEY]);
/** Every key a Claude client was built with, to prove the ambient server key is never picked up. */
const keysUsed: string[] = [];
let director = new ScriptedGateway([]);

const createGateway = (apiKey: string) => {
  keysUsed.push(apiKey);
  return {
    complete: (request: Parameters<ScriptedGateway["complete"]>[0]) => {
      if (rejected.has(apiKey)) {
        return Promise.reject(
          new MotionError("PROVIDER", "invalid x-api-key", { details: { reason: AUTH_REJECTED } }),
        );
      }
      return director.complete(request);
    },
    async verifyKey() {
      if (rejected.has(apiKey)) {
        throw new MotionError("PROVIDER", "invalid x-api-key", { details: { reason: AUTH_REJECTED } });
      }
    },
  };
};

let githubId = 700;
const mockFetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === GITHUB_TOKEN_URL) return Response.json({ access_token: "gho_claudetest0123456789" });
  if (url === "https://api.github.com/user") {
    return Response.json({
      id: githubId,
      login: `user${githubId}`,
      name: "U",
      avatar_url: "https://e.x/a.png",
    });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: `user${githubId}@example.com`, primary: true, verified: true }]);
  }
  return new Response("unexpected outbound call", { status: 500 });
}) as typeof fetch;

let h: Harness;
const ambient = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = AMBIENT_KEY;
  h = await startHarness(
    {
      GITHUB_CLIENT_ID: "Iv1.testclient",
      GITHUB_CLIENT_SECRET: "test-github-client-secret-0123456789",
      CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY,
      DEFAULT_DIRECTOR_MODE: "internal-opus",
      IMPLEMENTATION_MODE: "pi",
    },
    { claude: { createGateway, probe: () => ({ ok: false, mode: "bwrap", reason: "no user namespaces" }) } },
    { fetch: mockFetch },
  );
});

afterAll(async () => {
  if (ambient === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ambient;
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

async function allStoredText(): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out.push(await readFile(p, "utf8"));
    }
  };
  await walk(join(h.dataDir, "db"));
  return out.join("\n");
}

interface Overview {
  status: string;
  apiKey: { hint: string } | null;
  keyState?: { status: string };
  settings: {
    director: string;
    critic: string;
    sceneWorker: string;
    directorModel: string;
    fallback: string;
  };
  models: string[];
  worker: { available: boolean; reason?: string };
  subscription: { status: string; reason: string };
}

const overviewOf = async (cookie: string) =>
  (await (await request("/api/providers/claude", { cookie })).json()) as Overview;

describe("Claude provider API", () => {
  let owner: { cookie: string; workspaceId: string };
  let other: { cookie: string; workspaceId: string };

  beforeAll(async () => {
    owner = await signIn(701);
    other = await signIn(702);
  });

  it("starts unconfigured, keeps subscription sign-in blocked and requires a session", async () => {
    expect((await request("/api/providers/claude")).status).toBe(401);
    const view = await overviewOf(owner.cookie);
    expect(view.status).toBe("unconfigured");
    expect(view.apiKey).toBeNull();
    expect(view.settings).toMatchObject({ director: "openrouter", sceneWorker: "pi", fallback: "none" });
    expect(view.subscription.status).toBe("blocked_by_policy");
    expect(view.worker).toMatchObject({ available: false, reason: "no user namespaces" });
    expect(view.models).toContain("claude-opus-5-5");
    // No OAuth/subscription login exists for Claude.
    expect((await send("POST", "/api/providers/claude/login", owner.cookie, {})).status).toBe(404);
  });

  it("refuses malformed and rejected keys without storing them", async () => {
    const malformed = await send("PUT", "/api/providers/claude/api-key", owner.cookie, {
      apiKey: "sk-or-v1-x",
    });
    expect(malformed.status).toBe(400);
    const refused = await send("PUT", "/api/providers/claude/api-key", owner.cookie, {
      apiKey: REJECTED_KEY,
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(REJECTED_KEY);
    expect(
      await h.rt.repos.providerCredentials.get(owner.workspaceId, "claude", "anthropic"),
    ).toBeUndefined();
    const premature = await send("PUT", "/api/providers/claude/settings", owner.cookie, {
      director: "anthropic-api",
    });
    expect(premature.status).toBe(400);
  });

  it("stores a verified key sealed per workspace and returns only its hint", async () => {
    const put = await send("PUT", "/api/providers/claude/api-key", owner.cookie, { apiKey: GOOD_KEY });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain(GOOD_KEY);
    expect(JSON.parse(text)).toMatchObject({ status: "connected", apiKey: { hint: "6789" } });
    expect(await allStoredText()).not.toContain(GOOD_KEY);
    expect((await overviewOf(other.cookie)).status).toBe("unconfigured");

    expect(
      (await send("PUT", "/api/providers/claude/settings", owner.cookie, { directorModel: "gpt-5" })).status,
    ).toBe(400);
    expect(
      (await send("PUT", "/api/providers/claude/settings", owner.cookie, { sceneWorker: "claude-agent-sdk" }))
        .status,
    ).toBe(400);
    const settings = await send("PUT", "/api/providers/claude/settings", owner.cookie, {
      director: "anthropic-api",
      critic: "anthropic-api",
      directorModel: "claude-sonnet-5-5",
    });
    expect(settings.status).toBe(200);
    expect(((await settings.json()) as Overview).settings).toMatchObject({
      director: "anthropic-api",
      critic: "anthropic-api",
      directorModel: "claude-sonnet-5-5",
    });
  });

  it("marks a key Anthropic now rejects as revoked, and deletes it", async () => {
    rejected.add(GOOD_KEY);
    try {
      const res = await send("POST", "/api/providers/claude/test", owner.cookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { keyState: { status: string } }).keyState.status).toBe("rejected");
      expect((await overviewOf(owner.cookie)).status).toBe("revoked");
      expect(await h.rt.providers.claude.directorAvailable(owner.workspaceId)).toBe(false);
    } finally {
      rejected.delete(GOOD_KEY);
    }
    const retest = await send("POST", "/api/providers/claude/test", owner.cookie);
    expect(((await retest.json()) as { keyState: { status: string } }).keyState.status).toBe("valid");

    expect((await send("DELETE", "/api/providers/claude/api-key", other.cookie)).status).toBe(404);
    expect((await send("DELETE", "/api/providers/claude/api-key", owner.cookie)).status).toBe(204);
    expect((await overviewOf(owner.cookie)).status).toBe("unconfigured");
    expect(keysUsed).not.toContain(AMBIENT_KEY);
  });

  it("rate limits key checks per workspace", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await send("POST", "/api/providers/claude/test", other.cookie)).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await overviewOf(owner.cookie)).status).toBe("unconfigured");
  });
});

describe.skipIf(!canRender)("Claude director on the workspace key", { timeout: 300_000 }, () => {
  it("runs internal-opus without a server gateway, bills no director credits and pins the key", async () => {
    const ws = "ws_default";
    // API-key callers act on ws_default, which has no stored record until something creates one.
    await h.rt.repos.workspaces.create({ id: ws, name: "Default", ownerUserId: "usr_default" });
    await h.rt.providers.claude.setKey(ws, GOOD_KEY);
    await h.rt.providers.claude.updateSettings(ws, { director: "anthropic-api", critic: "anthropic-api" });
    director = new ScriptedGateway([SPEC_JSON]);
    keysUsed.length = 0;
    const client = await h.connect();

    const caps = await callOk<{ internalDirectorAvailable: boolean }>(client, "motion_inspect", {
      target: "capabilities",
    });
    expect(caps.internalDirectorAvailable).toBe(true);

    const created = await callOk<{ projectId: string; jobId: string; directorMode: string }>(
      client,
      "motion_create",
      { brief: "Launch video for Tracewise, a tracing tool.", durationSeconds: 6 },
    );
    expect(created.directorMode).toBe("internal-opus");
    const view = await waitForJob(client, created.projectId, created.jobId, ["succeeded"], 280_000, [
      "usage",
    ]);
    expect(director.callCount).toBe(1);
    expect(director.requests[0]?.model).toBe("claude-opus-5-5");
    expect(keysUsed.length).toBeGreaterThan(0);
    expect(new Set(keysUsed)).toEqual(new Set([GOOD_KEY]));
    const direction = view.usage?.breakdown.find((b) => b.operation === "creative_direction");
    expect(direction?.credits ?? 0).toBe(0);

    // Without the key and with no server gateway, the internal director is refused up front.
    await h.rt.providers.claude.deleteKey(ws);
    const refused = await call(client, "motion_create", {
      brief: "Another launch video.",
      durationSeconds: 6,
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.data)).toMatch(/internal director is not configured/);
  });
});
