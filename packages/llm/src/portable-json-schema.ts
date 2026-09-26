type Json = Record<string, unknown>;

/** Keywords some structured-output providers (notably Anthropic) reject; they are moved into descriptions. */
const CONSTRAINT_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "maxItems",
  "default",
] as const;

/**
 * Rewrite a JSON Schema into the subset every structured-output provider on OpenRouter accepts:
 * `oneOf` → `anyOf`, closed objects (`additionalProperties: false`), and value constraints moved into
 * `description` text. zod still enforces the full schema on the reply, and violations go through repair.
 */
export function toPortableJsonSchema(schema: Json): Json {
  return walk(schema) as Json;
}

function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk);
  if (node === null || typeof node !== "object") return node;
  const src = node as Json;
  const out: Json = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(src)) {
    if ((CONSTRAINT_KEYS as readonly string[]).includes(key)) {
      notes.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    if (key === "minItems" && typeof value === "number" && value > 1) {
      notes.push(`minItems: ${value}`);
      out.minItems = 1;
      continue;
    }
    if (key === "properties" || key === "$defs" || key === "definitions") {
      const mapped: Json = {};
      for (const [name, sub] of Object.entries(value as Json)) mapped[name] = walk(sub);
      out[key] = mapped;
      continue;
    }
    out[key === "oneOf" ? "anyOf" : key] = walk(value);
  }
  if (out.type === "object" && out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  if (notes.length) {
    const prefix = typeof out.description === "string" ? `${out.description} ` : "";
    out.description = `${prefix}(${notes.join(", ")})`;
  }
  return out;
}
