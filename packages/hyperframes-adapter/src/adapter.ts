import type { MotionIR } from "@motion-mcp/motion-ir";
import { type CompiledProject, type CompileOptions, compileProject } from "./compile.ts";
import { type DoctorOptions, type DoctorReport, doctor } from "./doctor.ts";
import {
  type ContactSheet,
  type ContactSheetOptions,
  checkProject,
  contactSheet,
  type InspectOptions,
  type SnapshotFrame,
  type SnapshotOptions,
  snapshotProject,
} from "./inspect.ts";
import { lintCompiledProject } from "./lint.ts";
import type { CheckReport } from "./qa.ts";
import { type RenderOptions, type RenderResult, renderProject } from "./render.ts";

/**
 * Renderer-neutral surface the pipeline drives. HyperFrames is the first implementation;
 * another renderer can implement the same shape against its own project format.
 */
export interface MotionRendererAdapter {
  readonly name: string;
  compile(ir: MotionIR, outDir: string, opts?: CompileOptions): Promise<CompiledProject>;
  lint(projectDir: string): Promise<CheckReport>;
  check(projectDir: string, opts?: InspectOptions): Promise<CheckReport>;
  snapshot(projectDir: string, opts: SnapshotOptions): Promise<SnapshotFrame[]>;
  contactSheet(projectDir: string, opts?: ContactSheetOptions): Promise<ContactSheet>;
  render(projectDir: string, opts: RenderOptions): Promise<RenderResult>;
  doctor(opts?: DoctorOptions): Promise<DoctorReport>;
}

export type HyperframesAdapter = MotionRendererAdapter & { readonly name: "hyperframes" };

export function createHyperframesAdapter(): HyperframesAdapter {
  return {
    name: "hyperframes",
    compile: compileProject,
    lint: lintCompiledProject,
    check: checkProject,
    snapshot: snapshotProject,
    contactSheet,
    render: renderProject,
    doctor,
  };
}
