import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";
import { type BillableOperation, CREDIT_PRICES, creditsToUsd, priceOf } from "./prices.ts";

/** What a video job is expected to consume. Everything except duration is optional. */
export const JobPlan = z.object({
  durationSeconds: z.number().positive().max(600),
  resolution: z.enum(["hd", "4k"]).default("hd"),
  /** `host-opus`: the MCP client authored the creative spec, so no internal director call is billed. */
  directorMode: z.enum(["host-opus", "internal-opus", "custom"]).default("internal-opus"),
  critiqueLoops: z.number().int().min(0).max(5).default(1),
  previews: z.number().int().min(0).max(20).default(1),
  images: z.number().int().min(0).max(200).default(0),
  videoSeconds: z.number().min(0).max(600).default(0),
  ttsChars: z.number().int().min(0).max(200_000).default(0),
  musicTracks: z.number().int().min(0).max(10).default(0),
  sfx: z.number().int().min(0).max(200).default(0),
  /** Workspace uses its own provider keys for media generation. */
  byok: z.boolean().default(false),
});
export type JobPlan = z.input<typeof JobPlan>;

export interface QuoteLine {
  operation: BillableOperation;
  quantity: number;
  unitCredits: number;
  credits: number;
  waived: boolean;
}

export interface JobQuote {
  lines: QuoteLine[];
  totalCredits: number;
  totalUsd: number;
}

/** Estimate the credits a video job will consume before it runs (used to size the reservation). */
export function quoteJob(input: JobPlan): JobQuote {
  const parsed = JobPlan.safeParse(input);
  if (!parsed.success) {
    throw new MotionError("VALIDATION", "Invalid job plan for quote", {
      details: { issues: parsed.error.issues },
    });
  }
  const plan = parsed.data;
  const minutes = plan.durationSeconds / 60;
  const usage: Array<[BillableOperation, number]> = [
    ["orchestration_job", 1],
    ["creative_direction", plan.directorMode === "host-opus" ? 0 : 1],
    ["creative_critique", plan.critiqueLoops],
    ["preview_render", plan.previews],
    [plan.resolution === "4k" ? "render_minute_4k" : "render_minute_hd", minutes],
    ["image_generation", plan.images],
    ["video_generation_second", plan.videoSeconds],
    ["tts_1k_chars", plan.ttsChars / 1000],
    ["music_track", plan.musicTracks],
    ["sfx", plan.sfx],
  ];
  const lines: QuoteLine[] = [];
  for (const [operation, quantity] of usage) {
    if (quantity <= 0) continue;
    const price = CREDIT_PRICES[operation];
    const waived = plan.byok && price.byokWaivable;
    lines.push({
      operation,
      quantity: Math.round(quantity * 1000) / 1000,
      unitCredits: price.credits,
      credits: priceOf(operation, quantity, { byok: plan.byok }),
      waived,
    });
  }
  const totalCredits = lines.reduce((sum, l) => sum + l.credits, 0);
  return { lines, totalCredits, totalUsd: creditsToUsd(totalCredits) };
}
