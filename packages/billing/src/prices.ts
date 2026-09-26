/**
 * Credit price list. 1 credit = $0.01 USD.
 *
 * Every price is set from an estimated cost of goods (`estCostUsd`, what the platform pays the provider
 * or the compute for one unit) so that gross margin is at least `TARGET_MARGIN`:
 *   margin = (credits * CREDIT_USD - estCostUsd) / (credits * CREDIT_USD)
 * Estimates are deliberately conservative (list prices, no volume discounts, retries included) and must
 * be revisited whenever a provider price or the render footprint changes; a unit test enforces the floor.
 */
export const CREDIT_USD = 0.01;
export const TARGET_MARGIN = 0.6;

export const BILLABLE_OPERATIONS = [
  "creative_direction",
  "creative_critique",
  "render_minute_hd",
  "render_minute_4k",
  "preview_render",
  "image_generation",
  "video_generation_second",
  "tts_1k_chars",
  "music_track",
  "sfx",
  "storage_gb_month",
  "api_call",
  "orchestration_job",
] as const;
export type BillableOperation = (typeof BILLABLE_OPERATIONS)[number];

export interface CreditPrice {
  /** Credits charged per unit. */
  credits: number;
  unit: string;
  /** Estimated platform cost per unit in USD, the basis for the margin check. */
  estCostUsd: number;
  /**
   * True when the cost is a third-party provider charge that disappears if the workspace brings its own
   * key (BYOK). Platform work (orchestration, rendering, storage, API) and the internal Opus director are
   * never waived because the platform still pays for them.
   */
  byokWaivable: boolean;
  basis: string;
}

export const CREDIT_PRICES: Readonly<Record<BillableOperation, CreditPrice>> = Object.freeze({
  creative_direction: {
    credits: 100,
    unit: "director call",
    estCostUsd: 0.4,
    byokWaivable: false,
    basis: "Internal Opus director: ~40k input + ~8k output tokens incl. one schema-repair retry",
  },
  creative_critique: {
    credits: 40,
    unit: "critique pass",
    estCostUsd: 0.15,
    byokWaivable: false,
    basis: "Opus/vision critique over a contact sheet: ~15k input incl. images + ~2k output tokens",
  },
  render_minute_hd: {
    credits: 25,
    unit: "output minute (<=1080p)",
    estCostUsd: 0.08,
    byokWaivable: false,
    basis: "Headless Chrome capture + x264 on shared vCPU, ~6 vCPU-minutes per output minute, plus finish",
  },
  render_minute_4k: {
    credits: 80,
    unit: "output minute (4K)",
    estCostUsd: 0.3,
    byokWaivable: false,
    basis: "About 4x the 1080p pixel work plus larger intermediate files",
  },
  preview_render: {
    credits: 8,
    unit: "draft preview",
    estCostUsd: 0.03,
    byokWaivable: false,
    basis: "Draft-quality low-res render or snapshot set, typically under 1 vCPU-minute",
  },
  image_generation: {
    credits: 10,
    unit: "image",
    estCostUsd: 0.04,
    byokWaivable: true,
    basis: "Upper range of current hosted image model list prices per 1 MP image",
  },
  video_generation_second: {
    credits: 25,
    unit: "generated video second",
    estCostUsd: 0.1,
    byokWaivable: true,
    basis: "Mid-tier hosted text/image-to-video list price per output second",
  },
  tts_1k_chars: {
    credits: 15,
    unit: "1,000 characters of speech",
    estCostUsd: 0.06,
    byokWaivable: true,
    basis: "Premium TTS list price per 1k characters, incl. one re-take",
  },
  music_track: {
    credits: 100,
    unit: "music track (<=3 min)",
    estCostUsd: 0.4,
    byokWaivable: true,
    basis: "Composition-plan music generation per track incl. an outro bed",
  },
  sfx: {
    credits: 5,
    unit: "sound effect",
    estCostUsd: 0.02,
    byokWaivable: true,
    basis: "Short generated SFX clip",
  },
  storage_gb_month: {
    credits: 5,
    unit: "GB-month",
    estCostUsd: 0.015,
    byokWaivable: false,
    basis: "R2 storage list price; egress is free on R2",
  },
  api_call: {
    credits: 1,
    unit: "billable API call",
    estCostUsd: 0.002,
    byokWaivable: false,
    basis: "Request handling, auth, tracing and database writes for metered API calls",
  },
  orchestration_job: {
    credits: 20,
    unit: "video job",
    estCostUsd: 0.08,
    byokWaivable: false,
    basis: "Cheap coder/decision models, Jev routing, lint/check/snapshot QA and queue overhead per job",
  },
});

export function creditsToUsd(credits: number): number {
  return Math.round(credits * CREDIT_USD * 100) / 100;
}

export function priceMargin(op: BillableOperation): number {
  const p = CREDIT_PRICES[op];
  const revenue = p.credits * CREDIT_USD;
  return (revenue - p.estCostUsd) / revenue;
}

/** Credits for `quantity` units of `op`, rounded up to whole credits; zero when waived under BYOK. */
export function priceOf(op: BillableOperation, quantity: number, options: { byok?: boolean } = {}): number {
  if (!Number.isFinite(quantity) || quantity < 0)
    throw new RangeError(`invalid quantity for ${op}: ${quantity}`);
  const p = CREDIT_PRICES[op];
  if (options.byok && p.byokWaivable) return 0;
  return Math.ceil(quantity * p.credits - 1e-9);
}
