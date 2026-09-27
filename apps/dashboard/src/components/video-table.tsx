import { Link } from "react-router";
import { formatDate, humanize } from "../lib/format.ts";
import type { ProjectListItem } from "../lib/types.ts";
import { StatusBadge } from "./ui.tsx";

export function VideoTable({ projects, caption }: { projects: ProjectListItem[]; caption: string }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Director</th>
            <th scope="col">{projects.some((p) => p.createdAt) ? "Created" : "Updated"}</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <th scope="row">
                <Link to={`/videos/${encodeURIComponent(p.id)}`}>{p.title || "Untitled video"}</Link>
              </th>
              <td>
                <StatusBadge status={p.status} />
              </td>
              <td>{p.directorMode ? humanize(p.directorMode) : "—"}</td>
              <td className="nowrap">{formatDate(p.createdAt ?? p.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
