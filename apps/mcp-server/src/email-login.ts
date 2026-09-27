import { MotionError } from "@motion-mcp/shared";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export interface MagicLinkEmail {
  apiKey: string;
  from: string;
  to: string;
  link: string;
  fetch: typeof fetch;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Send a sign-in link through the Resend REST API. Throws PROVIDER on any delivery failure. */
export async function sendMagicLinkEmail(input: MagicLinkEmail): Promise<void> {
  const link = escapeHtml(input.link);
  let res: Response;
  try {
    res = await input.fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: "Your Motion MCP sign-in link",
        text: `Sign in to Motion MCP: ${input.link}\n\nThis link expires in 15 minutes and works once. If you did not ask for it, ignore this email.`,
        html: `<p>Sign in to Motion MCP:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes and works once. If you did not ask for it, ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new MotionError("PROVIDER", "Email delivery request failed", { cause: err, retryable: true });
  }
  if (!res.ok) throw new MotionError("PROVIDER", `Email delivery failed with HTTP ${res.status}`);
}
