import { CreativeSpec, ScenePatch } from "@motion-mcp/motion-ir";
import { z } from "zod";

/**
 * Public MCP contract v0.1. These zod schemas are the authority served by `tools/list`;
 * docs/MCP_API.md describes them. Changes inside v0 are additive only.
 */

export const DirectorModeInput = z.enum(["host-opus", "internal-opus", "custom"]);
export const JobState = z.enum(["queued", "running", "awaiting_host", "succeeded", "failed", "cancelled"]);
export const Quality = z.enum(["preview", "final"]);
const Id = z.string().min(1).max(80);
const Credits = z.number().int().positive().max(1_000_000);

const FormatInput = z.object({
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(320).max(3840).optional(),
  fps: z.number().int().min(12).max(60).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
});

export const CreateInput = z.object({
  brief: z.string().min(3).max(8000).describe("What the video should communicate, for whom, and its feel."),
  directorMode: DirectorModeInput.optional().describe(
    "host-opus: you (the host model) are the creative director and must pass creativeSpec. " +
      "internal-opus: the server runs its own creative director. Defaults to the workspace setting.",
  ),
  creativeSpec: CreativeSpec.optional().describe(
    "Required for host-opus. Schema available from motion_inspect { target: 'capabilities' }.",
  ),
  recipeId: Id.optional(),
  format: FormatInput.optional(),
  durationSeconds: z.number().min(3).max(180).optional(),
  quality: Quality.default("preview"),
  budgetCredits: Credits.optional(),
});

export const CreateOutput = z.object({
  projectId: z.string(),
  jobId: z.string(),
  status: JobState,
  directorMode: DirectorModeInput,
  next: z.string(),
});

export const EditInput = z
  .object({
    projectId: Id,
    instruction: z.string().min(1).max(4000).optional(),
    scenePatches: z.array(ScenePatch).max(40).optional(),
    critiqueRequestId: Id.optional(),
    baseVersion: z.number().int().nonnegative().optional(),
    directorMode: DirectorModeInput.optional(),
    quality: Quality.default("preview"),
    budgetCredits: Credits.optional(),
  })
  .refine((v) => v.instruction !== undefined || (v.scenePatches?.length ?? 0) > 0, {
    message: "Provide instruction or scenePatches",
  });

export const EditOutput = z.object({
  projectId: z.string(),
  jobId: z.string(),
  version: z.number().int(),
  status: JobState,
  next: z.string(),
});

export const InspectInput = z.object({
  target: z.enum(["capabilities", "project", "scene", "styles"]).default("capabilities"),
  projectId: Id.optional(),
  sceneId: Id.optional(),
  version: z.number().int().nonnegative().optional(),
});

/** Inspect output varies by target; kept open so capabilities can grow additively. */
export const InspectOutput = z.object({ target: z.string() }).catchall(z.unknown());

export const RenderInput = z.object({
  projectId: Id,
  version: z.number().int().nonnegative().optional(),
  quality: Quality,
  format: z.enum(["mp4"]).default("mp4"),
  budgetCredits: Credits.optional(),
});

export const RenderOutput = z.object({
  projectId: z.string(),
  renderId: z.string(),
  jobId: z.string(),
  status: JobState,
  estimatedCredits: z.number().int(),
  next: z.string(),
});

export const SearchDocType = z.enum(["project", "scene", "style", "pattern", "recipe"]);

export const SearchInput = z.object({
  query: z.string().min(1).max(500),
  types: z.array(SearchDocType).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const SearchOutput = z.object({
  results: z.array(
    z.object({
      type: SearchDocType,
      id: z.string(),
      title: z.string(),
      snippet: z.string(),
      score: z.number(),
    }),
  ),
  exact: z.boolean(),
});

export const GetProjectInput = z.object({
  projectId: Id,
  include: z.array(z.enum(["versions", "renders", "usage", "trace", "ir"])).optional(),
});

export const RenderSummary = z.object({
  id: z.string(),
  quality: Quality,
  status: JobState,
  url: z.string().optional(),
  durationS: z.number().optional(),
  createdAt: z.string(),
});

export const GetProjectOutput = z.object({
  project: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    currentVersion: z.number().int(),
    directorMode: DirectorModeInput,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  job: z
    .object({
      id: z.string(),
      kind: z.string(),
      state: JobState,
      stage: z.string().optional(),
      progress: z.number().min(0).max(1),
      message: z.string().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .optional(),
  critiqueRequest: z.record(z.string(), z.unknown()).optional(),
  contactSheetUrl: z.string().optional(),
  renders: z.array(RenderSummary).optional(),
  versions: z
    .array(z.object({ version: z.number().int(), createdAt: z.string(), source: z.string() }))
    .optional(),
  usage: z
    .object({
      credits: z.number(),
      costUsd: z.number(),
      breakdown: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
  trace: z.string().optional(),
  ir: z.record(z.string(), z.unknown()).optional(),
});

export const ListProjectsInput = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  status: z.string().max(40).optional(),
});

export const ListProjectsOutput = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      updatedAt: z.string(),
      thumbnailUrl: z.string().optional(),
    }),
  ),
  nextCursor: z.string().optional(),
});

export const PublishInput = z.object({
  projectId: Id,
  renderId: Id,
  visibility: z.enum(["unlisted", "public"]).default("unlisted"),
});

export const PublishOutput = z.object({
  url: z.string(),
  renderId: z.string(),
  visibility: z.enum(["unlisted", "public"]),
});

export type CreateInput = z.output<typeof CreateInput>;
export type CreateOutput = z.output<typeof CreateOutput>;
export type EditInput = z.output<typeof EditInput>;
export type EditOutput = z.output<typeof EditOutput>;
export type InspectInput = z.output<typeof InspectInput>;
export type InspectOutput = z.output<typeof InspectOutput>;
export type RenderInput = z.output<typeof RenderInput>;
export type RenderOutput = z.output<typeof RenderOutput>;
export type SearchInput = z.output<typeof SearchInput>;
export type SearchOutput = z.output<typeof SearchOutput>;
export type GetProjectInput = z.output<typeof GetProjectInput>;
export type GetProjectOutput = z.output<typeof GetProjectOutput>;
export type ListProjectsInput = z.output<typeof ListProjectsInput>;
export type ListProjectsOutput = z.output<typeof ListProjectsOutput>;
export type PublishInput = z.output<typeof PublishInput>;
export type PublishOutput = z.output<typeof PublishOutput>;
