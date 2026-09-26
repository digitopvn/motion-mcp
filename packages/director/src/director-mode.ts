import { MotionError } from "@motion-mcp/shared";
import { z } from "zod";

export const DirectorMode = z.enum(["host-opus", "internal-opus", "custom"]);
export type DirectorMode = z.infer<typeof DirectorMode>;

export interface ResolveDirectorModeInput {
  /** Per-call mode from the tool arguments or the host's capability handshake. */
  requested?: DirectorMode;
  creativeSpecProvided: boolean;
  workspaceDefault: DirectorMode;
}

export interface ResolvedDirectorMode {
  mode: DirectorMode;
  source: "requested" | "creative-spec" | "workspace-default";
}

export const HOST_OPUS_GUIDANCE =
  'directorMode "host-opus" requires a creativeSpec. Call motion_inspect({ target: "capabilities" }) for the ' +
  'CreativeSpec JSON Schema and prompt guidance, author the spec, then pass it as creativeSpec. Or use "internal-opus".';

/**
 * Resolve the director mode from explicit signals only: the requested mode, then a supplied creativeSpec
 * (which is itself an explicit host-direction payload), then the workspace default. Model names, client
 * names and user agents are never consulted.
 */
export function resolveDirectorMode(input: ResolveDirectorModeInput): ResolvedDirectorMode {
  const requested = input.requested === undefined ? undefined : parseMode(input.requested, "requested");
  if (requested === "host-opus") {
    if (!input.creativeSpecProvided) {
      throw new MotionError("VALIDATION", HOST_OPUS_GUIDANCE, { details: { directorMode: "host-opus" } });
    }
    return { mode: "host-opus", source: "requested" };
  }
  if (requested) {
    if (input.creativeSpecProvided) {
      throw new MotionError(
        "VALIDATION",
        `A creativeSpec was supplied with directorMode "${requested}". Pass directorMode "host-opus" to use your spec, or omit creativeSpec to let the ${requested} director author one.`,
        { details: { directorMode: requested } },
      );
    }
    return { mode: requested, source: "requested" };
  }
  if (input.creativeSpecProvided) return { mode: "host-opus", source: "creative-spec" };
  const fallback = parseMode(input.workspaceDefault, "workspaceDefault");
  if (fallback === "host-opus") {
    throw new MotionError("VALIDATION", HOST_OPUS_GUIDANCE, {
      details: { directorMode: "host-opus", source: "workspace-default" },
    });
  }
  return { mode: fallback, source: "workspace-default" };
}

function parseMode(value: unknown, field: string): DirectorMode {
  const parsed = DirectorMode.safeParse(value);
  if (!parsed.success) {
    throw new MotionError(
      "VALIDATION",
      `Unknown director mode for ${field}; expected ${DirectorMode.options.join(", ")}`,
    );
  }
  return parsed.data;
}
