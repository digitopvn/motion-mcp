/**
 * Minimal JSON client for the dashboard `/api`. Every request uses the same-origin session cookie; a 401
 * anywhere hands control to `onUnauthorized` (the app sends the user to /login?next=...) and still rejects so
 * callers stop their own work.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the 401 handler, e.g. when the login page probes for an existing session. */
  allowUnauthorized?: boolean;
}

export interface ApiClientOptions {
  fetch: typeof fetch;
  onUnauthorized: () => void;
}

export interface ApiClient {
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, "body">): Promise<T>;
  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

const LOGIN_PATH = "/login";

/**
 * Returns a same-origin path that is safe to redirect to after sign-in. Anything that could leave the origin
 * (absolute URLs, protocol-relative `//host`, backslash tricks) or loop back to the login page becomes "/".
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw?.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (Array.from(raw).some((ch) => ch.charCodeAt(0) < 0x20)) return "/";
  if (raw === LOGIN_PATH || raw.startsWith(`${LOGIN_PATH}?`) || raw.startsWith(`${LOGIN_PATH}/`)) return "/";
  return raw;
}

/** `/login?next=<current path>`; the root path is omitted because it is the default. */
export function loginPath(next: string | null | undefined): string {
  const target = safeNext(next);
  return target === "/" ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(target)}`;
}

export function githubStartUrl(next: string | null | undefined): string {
  return `/api/auth/oauth/github/start?next=${encodeURIComponent(safeNext(next))}`;
}

async function readError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = response.statusText || `Request failed with status ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const { error, message: detail } = body as { error?: unknown; message?: unknown };
      if (typeof error === "string") code = error;
      if (typeof detail === "string") message = detail;
      else if (typeof error === "string") message = error.replaceAll("_", " ");
    }
  } catch {
    // Non-JSON error bodies (proxies, HTML error pages) keep the status text.
  }
  return new ApiError(response.status, code, message);
}

export function createApiClient({ fetch: fetchImpl, onUnauthorized }: ApiClientOptions): ApiClient {
  async function request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = { method, headers, credentials: "same-origin", signal: options.signal };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(path, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", "Could not reach the server. Check your connection and retry.");
    }

    if (response.status === 401) {
      if (!options.allowUnauthorized) onUnauthorized();
      throw new ApiError(401, "unauthorized", "Your session has ended. Sign in again.");
    }
    if (!response.ok) throw await readError(response);
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, "invalid_response", "The server sent an unreadable response.");
    }
  }

  return {
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, body, options) => request("POST", path, { ...options, body }),
    patch: (path, body) => request("PATCH", path, { body }),
    del: (path) => request("DELETE", path),
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
