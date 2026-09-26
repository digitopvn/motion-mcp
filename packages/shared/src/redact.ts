/**
 * Secret redaction for logs, traces and anything that might reach a model prompt.
 * Redaction is pattern-based plus value-based: callers can register known secret values
 * (for example provider keys loaded from the environment) so they are scrubbed verbatim.
 */

const REDACTED = "[redacted]";

const PATTERNS: RegExp[] = [
  // Authorization / bearer headers
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Common provider key shapes
  /\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bpolar_(?:oat|pat|sk)_[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bmmcp_[A-Za-z0-9_-]{16,}/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Signed URL query parameters (S3/R2 presigned, generic tokens)
  /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature|sig|token|access_token|api_key|apikey|key)=)[^&\s"']+/gi,
];

const KEY_VALUE =
  /(["']?(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|authorization|cookie|set-cookie|x-api-key|client[_-]?secret)["']?\s*[:=]\s*)(["']?)[^"'\s,}]+\2/gi;

const knownSecrets = new Set<string>();

/** Register literal secret values (min length 8) so they are always scrubbed. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

/** Register every environment variable whose name looks secret. */
export function registerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(name)) registerSecret(value);
  }
}

export function redact(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix?: string) => {
      if (typeof prefix === "string" && /[?&]/.test(prefix)) return `${prefix}${REDACTED}`;
      if (/^(Bearer|Basic)\s/i.test(match)) return `${match.split(/\s+/)[0]} ${REDACTED}`;
      return REDACTED;
    });
  }
  out = out.replace(KEY_VALUE, (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`);
  return out;
}

const SECRET_FIELD =
  /^(api[_-]?key|secret|password|token|access[_-]?token|authorization|cookie|set-cookie|x-api-key|client[_-]?secret|headers?)$/i;

/** Deep-redact a structured value (objects, arrays, strings). Returns a new value. */
export function redactDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key && SECRET_FIELD.test(key) && key.toLowerCase() !== "headers") return REDACTED;
      return redact(v);
    }
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((item) => walk(item));
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      if (k.toLowerCase() === "headers" && inner && typeof inner === "object") {
        const headers: Record<string, unknown> = {};
        for (const [hk, hv] of Object.entries(inner as Record<string, unknown>)) {
          headers[hk] = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i.test(hk)
            ? REDACTED
            : walk(hv, hk);
        }
        out[k] = headers;
      } else {
        out[k] = walk(inner, k);
      }
    }
    return out;
  };
  return walk(value) as T;
}
