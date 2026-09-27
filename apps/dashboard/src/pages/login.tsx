import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { errorMessage, githubStartUrl, safeNext } from "../lib/api.ts";
import { api } from "../lib/client.ts";
import type { Me, Providers } from "../lib/types.ts";
import { useDocumentTitle } from "../lib/use-api.ts";

const AUTH_ERRORS: Record<string, string> = {
  state_mismatch: "The sign-in attempt expired or was opened in another browser. Try again.",
  oauth_denied: "GitHub sign-in was cancelled.",
  oauth_failed: "GitHub sign-in failed. Try again in a moment.",
  github_disabled: "GitHub sign-in is not available right now.",
  link_invalid: "That sign-in link is invalid, expired or already used. Request a new one.",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  useDocumentTitle("Sign in");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const errorCode = params.get("error");

  const [providers, setProviders] = useState<Providers>({ github: true, email: false });
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    // Already signed in: skip the login page.
    api
      .get<Me>("/api/me", { signal: controller.signal, allowUnauthorized: true })
      .then(() => navigate(next, { replace: true }))
      .catch(() => undefined);
    // Providers default to GitHub-only when the probe fails.
    api
      .get<Providers>("/api/auth/providers", { signal: controller.signal, allowUnauthorized: true })
      .then((p) => setProviders({ github: p.github !== false, email: p.email === true }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [navigate, next]);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setFormError("Enter a valid email address.");
      return;
    }
    setSending(true);
    setFormError(undefined);
    try {
      await api.post("/api/auth/email/request", { email: address, next }, { allowUnauthorized: true });
      setSentTo(address);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="login">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="login-header">
        <a className="wordmark" href="https://motion.digitop.ai">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          <span>Motion MCP</span>
        </a>
      </header>
      <main id="main" className="login-main">
        <section className="login-card reveal" aria-labelledby="login-title">
          <p className="eyebrow">
            <span className="dot" aria-hidden="true" />
            Dashboard
          </p>
          <h1 id="login-title" className="login-title">
            Sign in to <em>Motion MCP.</em>
          </h1>
          <p className="lede">A motion studio your AI can direct: send a brief, get back a rendered MP4.</p>

          {errorCode ? (
            <p className="form-error" role="alert">
              {AUTH_ERRORS[errorCode] ?? "Sign-in failed. Try again."}
            </p>
          ) : null}

          <div className="login-actions">
            {providers.github ? (
              <a className="btn btn-primary btn-block" href={githubStartUrl(next)}>
                <GitHubMark />
                Continue with GitHub
              </a>
            ) : null}

            {providers.email ? (
              sentTo ? (
                <p className="notice" role="status">
                  Check <strong>{sentTo}</strong> for a sign-in link. It expires shortly.
                </p>
              ) : (
                <form className="login-email" onSubmit={requestLink} noValidate>
                  <p className="divider">
                    <span>or</span>
                  </p>
                  <label className="field">
                    <span className="field-label">Email</span>
                    <input
                      type="email"
                      name="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      aria-invalid={formError ? true : undefined}
                    />
                  </label>
                  {formError ? (
                    <p className="form-error" role="alert">
                      {formError}
                    </p>
                  ) : null}
                  <button type="submit" className="btn btn-quiet btn-block" disabled={sending}>
                    {sending ? "Sending…" : "Email me a sign-in link"}
                  </button>
                </form>
              )
            ) : null}
          </div>

          <p className="login-note">
            New here? Read how it works at <a href="https://motion.digitop.ai">motion.digitop.ai</a>. Your
            workspace starts with free trial credits.
          </p>
        </section>
      </main>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
