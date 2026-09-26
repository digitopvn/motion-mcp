import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyScenePatch,
  CreativeSpec,
  compileCreativeSpec,
  jsonSchemas,
  MotionIR,
  totalDuration,
} from "../src/index.ts";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../fixtures/golden", name, "creative-spec.json"),
      "utf8",
    ),
  );

describe("CreativeSpec → MotionIR", () => {
  const spec = CreativeSpec.parse(fixture("product-launch"));
  const ir = compileCreativeSpec(spec, { id: "proj_test" });

  it("produces a valid IR with totals matching scene durations", () => {
    expect(MotionIR.safeParse(ir).success).toBe(true);
    expect(ir.format).toMatchObject({ width: 1920, height: 1080, fps: 30, duration: 30 });
    expect(totalDuration(ir)).toBe(30);
  });

  it("derives choreography that starts with the hero and respects the hold ratio", () => {
    for (const scene of ir.scenes) {
      expect(scene.choreography.length).toBe(scene.elements.length);
      const hero = scene.elements.find((e) => e.role === "hero");
      expect(scene.choreography[0]?.target).toBe(hero?.id);
      const lastEnd = Math.max(
        ...scene.choreography.map((b) => (typeof b.at === "number" ? b.at : 0) + b.duration),
      );
      expect(lastEnd).toBeLessThanOrEqual(scene.duration * (1 - ir.motionLanguage.holdRatio) + 0.5);
    }
  });

  it("never picks an easing the taste packet avoids", () => {
    const eases = ir.scenes.flatMap((s) => s.choreography.map((b) => b.easing));
    expect(eases).not.toContain("spring-soft");
  });

  it("scales to a requested total duration", () => {
    const fitted = compileCreativeSpec(spec, { id: "proj_fit", duration: 15 });
    expect(fitted.format.duration).toBeCloseTo(15, 1);
  });

  it("rejects beats that reference unknown elements", () => {
    const bad = structuredClone(ir);
    bad.scenes[0]!.choreography.push({ target: "ghost", primitive: "fade-in", at: 0, duration: 0.5 });
    expect(MotionIR.safeParse(bad).success).toBe(false);
  });

  it("rejects raw hex colors in element styles (tokens only)", () => {
    const bad = structuredClone(ir) as unknown as { scenes: { elements: { style: { color: string } }[] }[] };
    bad.scenes[0]!.elements[0]!.style.color = "#ff0000";
    expect(MotionIR.safeParse(bad).success).toBe(false);
  });
});

describe("ScenePatch", () => {
  const ir = compileCreativeSpec(CreativeSpec.parse(fixture("product-launch")), { id: "proj_patch" });

  it("applies parameterized changes and defers instruction-only ones", () => {
    const before = ir.scenes[1]!.choreography.find((b) => b.target === "metric")!;
    const {
      ir: next,
      applied,
      deferred,
    } = applyScenePatch(ir, {
      sceneId: "s02-problem",
      source: "opus",
      changes: [
        {
          type: "timing",
          target: "metric",
          instruction: "Delay the metric reveal by 240ms.",
          params: { delaySeconds: 0.24 },
        },
        {
          type: "motion",
          target: "metric",
          instruction: "Remove spring easing.",
          params: { easing: "decelerate" },
        },
        { type: "motion", instruction: "Make the numbers feel heavier." },
      ],
    });
    const after = next.scenes[1]!.choreography.find((b) => b.target === "metric")!;
    expect(applied).toHaveLength(2);
    expect(deferred).toHaveLength(1);
    expect(after.at).toBeCloseTo((before.at as number) + 0.24, 3);
    expect(after.easing).toBe("decelerate");
    // Original IR is untouched.
    expect(ir.scenes[1]!.choreography.find((b) => b.target === "metric")!.at).toBe(before.at);
  });
});

describe("JSON Schema export", () => {
  it("exports schemas for host models", () => {
    const schemas = jsonSchemas();
    expect(schemas.creativeSpec).toHaveProperty("properties.tastePacket");
    expect(schemas.motionIR).toHaveProperty("properties.scenes");
  });
});
