import { Link } from "react-router";
import { PageHeader } from "../components/ui.tsx";
import { useDocumentTitle } from "../lib/use-api.ts";

export function NotFoundPage() {
  useDocumentTitle("Not found");
  return (
    <>
      <PageHeader title="Page not found" intro="That page does not exist in this workspace." />
      <Link className="btn btn-primary" to="/">
        Back to overview
      </Link>
    </>
  );
}
