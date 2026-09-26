import { createHmac, timingSafeEqual } from "node:crypto";
import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";
import type { CreditLedger } from "./ledger.ts";
import type { LedgerTransaction } from "./ledger-store.ts";

/** Default replay window for webhook timestamps (Standard Webhooks recommends 5 minutes). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Secret bytes for HMAC. A Standard Webhooks secret (`whsec_<base64>`) is base64-decoded. Polar dashboard
 * secrets are plain strings that Polar's own SDK base64-encodes before handing them to the Standard Webhooks
 * verifier, which then decodes them again, so the effective key is the secret's UTF-8 bytes.
 */
export function webhookSecretKey(secret: string): Buffer {
  if (!secret) throw new MotionError("CONFIG", "Webhook secret is not configured");
  if (secret.startsWith("whsec_")) return Buffer.from(secret.slice("whsec_".length), "base64");
  return Buffer.from(secret, "utf8");
}

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", webhookSecretKey(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${mac}`;
}

export interface VerifyWebhookInput {
  headers: HeaderSource;
  /** Raw request body exactly as received; never a re-serialized object. */
  body: string | Uint8Array;
  secret: string;
  toleranceSeconds?: number;
  now?: () => number;
}

/**
 * Verify a Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`) and return
 * the parsed JSON payload. Throws UNAUTHORIZED on any mismatch; the message never echoes the signature.
 */
export function verifyWebhook(input: VerifyWebhookInput): unknown {
  const id = header(input.headers, "webhook-id");
  const timestamp = header(input.headers, "webhook-timestamp");
  const signatures = header(input.headers, "webhook-signature");
  if (!id || !timestamp || !signatures)
    throw new MotionError("UNAUTHORIZED", "Missing webhook signature headers");
  if (!/^\d{1,12}$/.test(timestamp)) throw new MotionError("UNAUTHORIZED", "Invalid webhook timestamp");

  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const ts = Number(timestamp);
  if (nowSeconds - ts > tolerance) throw new MotionError("UNAUTHORIZED", "Webhook timestamp too old");
  if (ts - nowSeconds > tolerance)
    throw new MotionError("UNAUTHORIZED", "Webhook timestamp is in the future");

  const body = typeof input.body === "string" ? input.body : Buffer.from(input.body).toString("utf8");
  const expected = Buffer.from(
    createHmac("sha256", webhookSecretKey(input.secret)).update(`${id}.${ts}.${body}`).digest(),
  );
  let valid = false;
  for (const candidate of signatures.split(" ")) {
    const [version, sig] = candidate.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
  }
  if (!valid) throw new MotionError("UNAUTHORIZED", "Invalid webhook signature");

  try {
    return JSON.parse(body);
  } catch (err) {
    throw new MotionError("VALIDATION", "Webhook body is not JSON", { cause: err });
  }
}

const PolarOrder = z.looseObject({
  id: z.string().min(1),
  currency: z.string().min(3),
  net_amount: z.number().int().nonnegative().optional(),
  subtotal_amount: z.number().int().nonnegative().optional(),
  discount_amount: z.number().int().nonnegative().optional(),
  product_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  customer_id: z.string().nullish(),
  customer: z.looseObject({ external_id: z.string().nullish() }).nullish(),
});
export type PolarOrder = z.infer<typeof PolarOrder>;

const PolarEvent = z.looseObject({ type: z.string().min(1), data: z.unknown() });

export interface PolarGrantOptions {
  /** Credits sold per Polar product id (packs, bonuses). Takes precedence over amount-based credits. */
  creditsByProduct?: Record<string, number>;
}

export interface PolarGrant {
  workspaceId: string;
  credits: number;
  idempotencyKey: string;
  orderId: string;
}

/**
 * Map a paid order to a grant. The workspace comes from checkout metadata `workspace_id` (set by our server
 * when it creates the checkout) or the customer's `external_id`. Credits come from the product map, else
 * from the USD net amount in cents (1 credit = $0.01, taxes excluded).
 */
export function polarOrderToGrant(order: PolarOrder, options: PolarGrantOptions = {}): PolarGrant {
  const metaWs = order.metadata?.workspace_id;
  const workspaceId = typeof metaWs === "string" && metaWs ? metaWs : order.customer?.external_id;
  if (!workspaceId) throw new MotionError("VALIDATION", `Polar order ${order.id} has no workspace reference`);

  let credits: number | undefined;
  if (order.product_id && options.creditsByProduct?.[order.product_id] !== undefined) {
    credits = options.creditsByProduct[order.product_id];
  } else if (order.currency.toLowerCase() === "usd") {
    credits = order.net_amount ?? (order.subtotal_amount ?? 0) - (order.discount_amount ?? 0);
  } else {
    throw new MotionError(
      "VALIDATION",
      `Polar order ${order.id} uses unsupported currency ${order.currency}`,
    );
  }
  if (!Number.isInteger(credits) || credits === undefined || credits <= 0) {
    throw new MotionError("VALIDATION", `Polar order ${order.id} maps to no credits`);
  }
  return { workspaceId, credits, idempotencyKey: `polar:order:${order.id}`, orderId: order.id };
}

export interface PolarWebhookResult {
  type: string;
  handled: boolean;
  transaction?: LedgerTransaction;
}

/**
 * Verify and apply a Polar webhook. `order.paid` grants credits (idempotent per order id, so Polar
 * redeliveries are harmless); every other event type is acknowledged without side effects.
 */
export async function handlePolarWebhook(
  input: VerifyWebhookInput & { ledger: CreditLedger } & PolarGrantOptions,
): Promise<PolarWebhookResult> {
  const payload = verifyWebhook(input);
  const event = PolarEvent.safeParse(payload);
  if (!event.success) throw new MotionError("VALIDATION", "Unrecognized Polar webhook payload");
  if (event.data.type !== "order.paid") return { type: event.data.type, handled: false };

  const order = PolarOrder.safeParse(event.data.data);
  if (!order.success) throw new MotionError("VALIDATION", "Invalid Polar order payload");
  const grant = polarOrderToGrant(order.data, input);
  const transaction = await input.ledger.grant({
    workspaceId: grant.workspaceId,
    credits: grant.credits,
    source: "polar",
    idempotencyKey: grant.idempotencyKey,
    metadata: { orderId: grant.orderId },
  });
  return { type: event.data.type, handled: true, transaction };
}
