/**
 * Marketing site Worker. Static assets are served by the assets binding; only `/api/*` runs this script
 * (`run_worker_first`). The GitHub OAuth app's registered callback lives on this host, so auth routes are
 * redirected to the app, and the Polar webhook is proxied there (a POST body cannot follow a redirect).
 */

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Origin of the dashboard/MCP app, e.g. https://app.motion.digitop.ai (wrangler var). */
  APP_ORIGIN?: string;
}

const DEFAULT_APP_ORIGIN = "https://app.motion.digitop.ai";
/** Hop-by-hop or host-bound headers that must not be forwarded to the app. */
const DROP_HEADERS = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding"]);

function appOrigin(env: Env): string {
  try {
    const url = new URL(env.APP_ORIGIN || DEFAULT_APP_ORIGIN);
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : DEFAULT_APP_ORIGIN;
  } catch {
    return DEFAULT_APP_ORIGIN;
  }
}

const notFound = () =>
  new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/api" && !path.startsWith("/api/")) return env.ASSETS.fetch(request);

  if (path.startsWith("/api/auth/") && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${appOrigin(env)}${path}${url.search}`, "Cache-Control": "no-store" },
    });
  }

  if (path === "/api/webhooks/polar") {
    const headers = new Headers();
    request.headers.forEach((value, name) => {
      if (!DROP_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    try {
      const upstream = await fetchImpl(`${appOrigin(env)}/webhooks/polar${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        redirect: "manual",
      });
      // The body is already decoded by fetch, so only the content type is passed back.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ error: "upstream_unavailable" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return notFound();
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
};
