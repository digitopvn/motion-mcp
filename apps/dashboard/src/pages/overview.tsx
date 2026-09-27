import { Link } from "react-router";
import { Async, CodeCard, EmptyState, PageHeader } from "../components/ui.tsx";
import { VideoTable } from "../components/video-table.tsx";
import { creditsToUsd, formatCredits } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";
import type { Overview } from "../lib/types.ts";
import { useApi, useDocumentTitle } from "../lib/use-api.ts";

const MCP_ENDPOINT = "https://app.motion.digitop.ai/mcp";

const MCP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      motion: {
        type: "http",
        url: MCP_ENDPOINT,
        headers: { Authorization: "Bearer mmcp_YOUR_API_KEY" },
      },
    },
  },
  null,
  2,
);

export function OverviewPage() {
  useDocumentTitle("Overview");
  const { me } = useSession();
  const overview = useApi<Overview>("/api/overview");
  const credits = overview.data?.credits ?? me.credits;
  const firstName = me.user.name?.split(" ")[0];

  return (
    <>
      <PageHeader
        eyebrow={me.workspace.name}
        title={firstName ? `Welcome back, ${firstName}.` : "Welcome back."}
        actions={
          <Link className="btn btn-primary" to="/videos/new">
            New video
          </Link>
        }
      />

      <section className="stat-grid" aria-label="Credits">
        <div className="stat">
          <p className="stat-label">Balance</p>
          <p className="stat-value">{formatCredits(credits.balance)}</p>
          <p className="stat-note">{creditsToUsd(credits.balance)} at $0.01 per credit</p>
        </div>
        <div className="stat">
          <p className="stat-label">Held by running jobs</p>
          <p className="stat-value">{formatCredits(credits.held)}</p>
          <p className="stat-note">Released or charged when a job finishes</p>
        </div>
        <div className="stat">
          <p className="stat-label">Recent usage</p>
          <p className="stat-value">{formatCredits(overview.data?.usage?.credits)}</p>
          <p className="stat-note">
            Last 30 days
            {overview.data?.usage?.events !== undefined ? ` · ${overview.data.usage.events} events` : ""}
          </p>
        </div>
      </section>

      {overview.data?.trialCredits ? (
        <p className="notice">
          Your workspace started with a free trial of{" "}
          <strong>{formatCredits(overview.data.trialCredits)}</strong>. Previews are cheap; final renders are
          billed per output minute. <Link to="/billing">See prices</Link>.
        </p>
      ) : overview.data?.projectCount === 0 ? (
        <p className="notice">
          New workspaces include free trial credits, enough for several previews. Final renders are billed per
          output minute. <Link to="/billing">See prices</Link>.
        </p>
      ) : null}

      <div className="overview-grid">
        <section className="panel" aria-labelledby="recent-title">
          <div className="panel-head">
            <h2 id="recent-title" className="h3">
              Recent videos
            </h2>
            <Link to="/videos">All videos</Link>
          </div>
          <Async state={overview} label="Loading recent videos">
            {(data) =>
              data.recentProjects && data.recentProjects.length > 0 ? (
                <VideoTable projects={data.recentProjects} caption="Recent videos" />
              ) : (
                <EmptyState title="No videos yet">
                  <p>
                    Create one here, or connect your MCP client and ask your model to call{" "}
                    <code>motion_create</code>.
                  </p>
                  <Link className="btn btn-primary btn-sm" to="/videos/new">
                    New video
                  </Link>
                </EmptyState>
              )
            }
          </Async>
        </section>

        <section className="panel panel-inverse" aria-labelledby="connect-title">
          <h2 id="connect-title" className="h3">
            Connect your MCP client
          </h2>
          <ol className="connect-steps">
            <li>
              <Link to="/keys">Create an API key</Link>.
            </li>
            <li>Paste this config and replace the placeholder with the key.</li>
            <li>
              Ask your model to call <code>motion_inspect</code>, then <code>motion_create</code>.
            </li>
          </ol>
          <CodeCard file="mcp.json" code={MCP_CONFIG} label="MCP client configuration" />
        </section>
      </div>
    </>
  );
}
