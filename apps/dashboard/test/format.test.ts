import { describe, expect, it } from "vitest";
import {
  creditsToUsd,
  estimateVideoCost,
  formatCredits,
  formatEstimate,
  formatUsd,
  normalizePrices,
} from "../src/lib/format.ts";
import { summarizeUsage } from "../src/lib/usage.ts";

const PRICES = normalizePrices({
  creative_direction: { credits: 100, unit: "director call" },
  orchestration_job: { credits: 20, unit: "video job" },
  preview_render: { credits: 8, unit: "draft preview" },
  render_minute_hd: { credits: 25, unit: "output minute (<=1080p)" },
});

describe("credit formatting", () => {
  it("formats credits and their dollar value", () => {
    expect(formatCredits(1)).toBe("1 credit");
    expect(formatCredits(12500)).toBe("12,500 credits");
    expect(formatCredits(undefined)).toBe("—");
    expect(creditsToUsd(128)).toBe("$1.28");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(3)).toBe("$3.00");
  });
});

describe("normalizePrices", () => {
  it("accepts arrays and records and sorts by operation", () => {
    expect(PRICES.map((p) => p.operation)).toEqual([
      "creative_direction",
      "orchestration_job",
      "preview_render",
      "render_minute_hd",
    ]);
    expect(normalizePrices([{ operation: "sfx", credits: 5, unit: "sound effect" }])).toHaveLength(1);
    expect(normalizePrices(undefined)).toEqual([]);
  });
});

describe("estimateVideoCost", () => {
  it("prices an internal-opus preview as orchestration + direction + preview", () => {
    const estimate = estimateVideoCost(
      { directorMode: "internal-opus", quality: "preview", durationSeconds: 20 },
      PRICES,
    );
    expect(estimate?.total).toBe(128);
    expect(formatEstimate(estimate)).toBe("≈ 128 credits ($1.28)");
  });

  it("bills final renders per output minute, rounded up", () => {
    const estimate = estimateVideoCost(
      { directorMode: "custom", quality: "final", durationSeconds: 30 },
      PRICES,
    );
    // 20 orchestration + ceil(0.5 * 25) render, no Opus direction for custom.
    expect(estimate?.total).toBe(33);
  });

  it("returns null when a required price is missing", () => {
    expect(
      estimateVideoCost({ directorMode: "internal-opus", quality: "preview", durationSeconds: 10 }, []),
    ).toBeNull();
    expect(formatEstimate(null)).toBe("Estimate unavailable");
  });
});

describe("summarizeUsage", () => {
  it("groups by local day and operation, newest first", () => {
    const rows = summarizeUsage([
      { operation: "preview_render", credits: 8, createdAt: new Date(2026, 8, 26, 10).toISOString() },
      { operation: "preview_render", credits: 8, createdAt: new Date(2026, 8, 26, 12).toISOString() },
      { operation: "creative_direction", credits: 100, createdAt: new Date(2026, 8, 27, 9).toISOString() },
      { operation: "api_call", credits: 1, createdAt: "not a date" },
    ]);
    expect(rows).toEqual([
      { date: "2026-09-27", operation: "creative_direction", count: 1, quantity: 1, credits: 100 },
      { date: "2026-09-26", operation: "preview_render", count: 2, quantity: 2, credits: 16 },
    ]);
  });
});
