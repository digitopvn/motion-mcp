import { z } from "zod";
import { CreativeSpec, TastePacket } from "./creative-spec.ts";
import { MotionIR } from "./motion-ir.ts";
import { ScenePatch } from "./patch-and-qa.ts";

export * from "./apply-patch.ts";
export * from "./compile-spec.ts";
export * from "./creative-spec.ts";
export * from "./motion-ir.ts";
export * from "./patch-and-qa.ts";
export * from "./tokens.ts";

/** JSON Schemas for host models and external tooling (MCP `motion_inspect` capabilities). */
export function jsonSchemas() {
  return {
    creativeSpec: z.toJSONSchema(CreativeSpec, { io: "input" }),
    tastePacket: z.toJSONSchema(TastePacket, { io: "input" }),
    motionIR: z.toJSONSchema(MotionIR, { io: "input" }),
    scenePatch: z.toJSONSchema(ScenePatch, { io: "input" }),
  };
}
