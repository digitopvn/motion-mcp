import { useEffect, useId, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { ApiError, errorMessage } from "../lib/api.ts";
import { api } from "../lib/client.ts";
import { formatCredits } from "../lib/format.ts";
import { SessionProvider } from "../lib/session.tsx";
import type { Me, User } from "../lib/types.ts";
import { useApi } from "../lib/use-api.ts";
import { ErrorState, Loading } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/videos", label: "Videos", end: false },
  { to: "/search", label: "Search", end: false },
  { to: "/recipes", label: "Recipes", end: false },
  { to: "/keys", label: "API keys", end: false },
  { to: "/providers", label: "Model providers", end: false },
  { to: "/billing", label: "Usage & billing", end: false },
  { to: "/settings", label: "Settings", end: false },
] as const;

/**
 * Ends the session and leaves for the login page. An already-expired session (401) counts as signed out;
 * any other failure is returned so the caller can show it, because the cookie may still be valid.
 */
export async function signOut(): Promise<string | undefined> {
  try {
    await api.post("/api/auth/logout", undefined, { allowUnauthorized: true });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) return errorMessage(error);
  }
  window.location.assign("/login");
  return undefined;
}

export function initials(user: User): string {
  const source = user.name?.trim() || user.email?.trim() || "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ user, size = 32 }: { user: User; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (user.avatarUrl && !failed) {
    return (
      <img
        className="avatar"
        src={user.avatarUrl}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="avatar avatar-initials" style={{ width: size, height: size }} aria-hidden="true">
      {initials(user)}
    </span>
  );
}

function UserMenu({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | undefined>(undefined);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="user-button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar user={user} />
        <span className="user-name">{user.name || user.email || "Account"}</span>
        <span className="visually-hidden">Account menu</span>
      </button>
      <div id={menuId} className="user-popover" hidden={!open}>
        <p className="user-popover-email">{user.email ?? user.name}</p>
        <NavLink to="/settings" className="menu-item" onClick={() => setOpen(false)}>
          Settings
        </NavLink>
        <button
          type="button"
          className="menu-item"
          disabled={signingOut}
          onClick={async () => {
            setSigningOut(true);
            setSignOutError(await signOut());
            setSigningOut(false);
          }}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
        {signOutError ? (
          <p className="form-error" role="alert">
            {signOutError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AppShell() {
  const me = useApi<Me>("/api/me");
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile nav after navigating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change only.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  if (!me.data) {
    return (
      <main className="boot" id="main">
        {me.error ? (
          <ErrorState message={me.error} onRetry={me.reload} />
        ) : (
          <Loading label="Loading workspace" />
        )}
      </main>
    );
  }

  const { user, workspace, credits } = me.data;

  return (
    <SessionProvider value={{ me: me.data, refresh: me.reload }}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <header className="sidebar">
          <div className="sidebar-top">
            <NavLink className="wordmark" to="/" aria-label="Motion MCP overview">
              <img src="/favicon.svg" alt="" width="28" height="28" />
              <span>Motion MCP</span>
            </NavLink>
            <button
              type="button"
              className="nav-toggle"
              aria-expanded={navOpen}
              aria-controls="primary-nav"
              onClick={() => setNavOpen((v) => !v)}
            >
              {navOpen ? "Close" : "Menu"}
            </button>
          </div>
          <div className={`sidebar-body${navOpen ? " is-open" : ""}`} id="primary-nav">
            <div className="workspace-card">
              <p className="eyebrow">Workspace</p>
              <p className="workspace-name">{workspace.name}</p>
              <p className="workspace-balance">
                <span className="balance-value">{formatCredits(credits.balance)}</span>
                {credits.held > 0 ? (
                  <span className="muted"> · {formatCredits(credits.held)} held</span>
                ) : null}
              </p>
            </div>
            <nav aria-label="Primary">
              <ul className="side-nav">
                {NAV.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
            <UserMenu user={user} />
          </div>
        </header>
        <main id="main" className="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </SessionProvider>
  );
}
