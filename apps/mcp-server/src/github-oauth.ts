import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API = "https://api.github.com";
export const GITHUB_SCOPE = "read:user user:email";

const TIMEOUT_MS = 10_000;

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  fetch: typeof fetch;
}

export interface GithubProfile {
  githubId: string;
  login: string;
  name: string;
  avatarUrl?: string;
  /** Primary verified email, when the account has one. */
  email?: string;
}

export function githubAuthorizeUrl(cfg: Pick<GithubOAuthConfig, "clientId" | "callbackUrl">, state: string) {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.callbackUrl);
  url.searchParams.set("scope", GITHUB_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

const TokenResponse = z.union([
  z.looseObject({ access_token: z.string().min(1) }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);

const GithubUser = z.looseObject({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullish(),
  avatar_url: z.string().nullish(),
});

const GithubEmails = z.array(
  z.looseObject({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
);

async function getJson(cfg: GithubOAuthConfig, url: string, init: RequestInit, what: string) {
  let res: Response;
  try {
    res = await cfg.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new MotionError("PROVIDER", `GitHub ${what} request failed`, { cause: err, retryable: true });
  }
  if (!res.ok) throw new MotionError("PROVIDER", `GitHub ${what} returned HTTP ${res.status}`);
  try {
    return (await res.json()) as unknown;
  } catch (err) {
    throw new MotionError("PROVIDER", `GitHub ${what} returned invalid JSON`, { cause: err });
  }
}

/** Exchange the authorization code for a user token, then read the profile and primary verified email. */
export async function fetchGithubProfile(cfg: GithubOAuthConfig, code: string): Promise<GithubProfile> {
  const token = TokenResponse.safeParse(
    await getJson(
      cfg,
      GITHUB_TOKEN_URL,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: cfg.callbackUrl,
        }),
      },
      "token exchange",
    ),
  );
  if (!token.success || !("access_token" in token.data)) {
    throw new MotionError("UNAUTHORIZED", "GitHub rejected the authorization code");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token.data.access_token}`,
    "User-Agent": "motion-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const user = GithubUser.safeParse(await getJson(cfg, `${GITHUB_API}/user`, { headers }, "user"));
  if (!user.success) throw new MotionError("PROVIDER", "Unexpected GitHub user response");
  // Email is optional for a GitHub login; a failed lookup only means the account has no known email.
  const emails = GithubEmails.safeParse(
    await getJson(cfg, `${GITHUB_API}/user/emails`, { headers }, "emails").catch(() => undefined),
  );
  const primary = emails.success ? emails.data.find((e) => e.primary && e.verified) : undefined;
  const email = primary && z.email().safeParse(primary.email).success ? primary.email : undefined;
  const avatar = user.data.avatar_url && z.url().safeParse(user.data.avatar_url).success;
  return {
    githubId: String(user.data.id),
    login: user.data.login,
    name: (user.data.name?.trim() || user.data.login).slice(0, 200),
    avatarUrl: avatar ? (user.data.avatar_url ?? undefined) : undefined,
    email,
  };
}
