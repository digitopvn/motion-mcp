import type { GuardDecision, PathGuard } from "@motion-mcp/pi-runtime";

/** Built-in Claude Code tools a scene worker may use. Everything else (Bash, web, subagents) is off. */
export const CLAUDE_FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;

/**
 * Apply the shared Motion path guard to a Claude Code tool call. Claude's file tools use different names
 * and argument shapes from Pi's, so each is mapped onto the Pi equivalent the guard already understands.
 * Unknown tools are denied.
 */
export function checkClaudeTool(guard: PathGuard, toolName: string, input: unknown): GuardDecision {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (toolName) {
    case "Read":
      return guard.check("read", { path: args.file_path });
    case "Write":
      return guard.check("write", { path: args.file_path });
    case "Edit":
      return guard.check("edit", { path: args.file_path });
    case "Glob":
      return guard.check("find", { path: args.path, pattern: args.pattern });
    case "Grep":
      return guard.check("grep", { path: args.path, glob: args.glob });
    default:
      return guard.check(toolName, args);
  }
}
