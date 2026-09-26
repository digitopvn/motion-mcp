import { MotionIR, type MotionScene } from "@motion-mcp/motion-ir";
import type { SceneContext } from "../src/prompt-builder.ts";

export const ir = MotionIR.parse({
  version: "0.1",
  id: "demo",
  format: { width: 1920, height: 1080, fps: 30 },
  creative: { concept: "Calm, precise product reveal" },
  brand: {
    colors: { background: "#0a0a0a", foreground: "#f4f4f5", accent: "#22d3ee" },
    fonts: { display: "Inter", body: "Inter" },
  },
  motionLanguage: { tempo: "measured" },
  scenes: [
    {
      id: "intro",
      role: "hook",
      intent: "Introduce the product name with a confident reveal",
      duration: 4,
      focalPoint: "product name",
      elements: [
        { id: "title", kind: "text", text: "Motion MCP", role: "hero", style: { size: "display" } },
        { id: "sub", kind: "text", text: "Video from a brief", role: "secondary" },
      ],
      choreography: [
        { target: "title", primitive: "mask-reveal", at: 0.2, duration: 0.8 },
        { target: "sub", primitive: "fade-up", at: { after: "title", offset: 0.1 } },
      ],
      acceptance: ["Title is readable for at least 2 seconds"],
      implementation: "custom",
    },
  ],
});

export const scene: MotionScene = ir.scenes[0] as MotionScene;
export const context: SceneContext = {
  format: ir.format,
  brand: ir.brand,
  motionLanguage: ir.motionLanguage,
};
