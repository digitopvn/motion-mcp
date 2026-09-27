import { useState } from "react";
import { Avatar, signOut } from "../components/app-shell.tsx";
import { CopyButton, PageHeader } from "../components/ui.tsx";
import { useSession } from "../lib/session.tsx";
import { useDocumentTitle } from "../lib/use-api.ts";

export function SettingsPage() {
  useDocumentTitle("Settings");
  const { me } = useSession();
  const { user, workspace } = me;
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSignOut() {
    setSigningOut(true);
    setError(await signOut());
    setSigningOut(false);
  }

  return (
    <>
      <PageHeader title="Settings" />

      <section className="panel" aria-labelledby="profile-title">
        <h2 id="profile-title" className="h3">
          Profile
        </h2>
        <div className="profile">
          <Avatar user={user} size={64} />
          <dl className="facts">
            <div>
              <dt>Name</dt>
              <dd>{user.name || "—"}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{user.email || "—"}</dd>
            </div>
          </dl>
        </div>
        <p className="muted small">Your name, email and avatar come from the account you signed in with.</p>
      </section>

      <section className="panel" aria-labelledby="workspace-title">
        <h2 id="workspace-title" className="h3">
          Workspace
        </h2>
        <dl className="facts">
          <div>
            <dt>Name</dt>
            <dd>{workspace.name}</dd>
          </div>
          <div>
            <dt>Workspace ID</dt>
            <dd className="with-copy">
              <code>{workspace.id}</code>
              <CopyButton text={workspace.id} label="Copy ID" />
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="session-title">
        <h2 id="session-title" className="h3">
          Session
        </h2>
        <p className="muted">Signing out ends this browser session. API keys keep working.</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="button" className="btn btn-quiet" onClick={onSignOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>
    </>
  );
}
