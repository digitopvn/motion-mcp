import type {
  CreateInput,
  CreateOutput,
  EditInput,
  EditOutput,
  GetProjectInput,
  GetProjectOutput,
  InspectInput,
  InspectOutput,
  ListProjectsInput,
  ListProjectsOutput,
  PublishInput,
  PublishOutput,
  RenderInput,
  RenderOutput,
  SearchInput,
  SearchOutput,
} from "./tool-schemas.ts";

/** The authenticated caller. Derived from the bearer key at the HTTP layer, never from tool input. */
export interface CallerContext {
  workspaceId: string;
  keyId: string;
  /** Optional host capability hint from `initialize` clientInfo; informational only, never used to pick a mode. */
  clientName?: string;
}

/**
 * Application service behind the eight public tools. The MCP layer only validates, authenticates
 * and maps errors; all behavior lives in the implementation (packages/pipeline).
 */
export interface MotionService {
  create(caller: CallerContext, input: CreateInput): Promise<CreateOutput>;
  edit(caller: CallerContext, input: EditInput): Promise<EditOutput>;
  inspect(caller: CallerContext, input: InspectInput): Promise<InspectOutput>;
  render(caller: CallerContext, input: RenderInput): Promise<RenderOutput>;
  search(caller: CallerContext, input: SearchInput): Promise<SearchOutput>;
  getProject(caller: CallerContext, input: GetProjectInput): Promise<GetProjectOutput>;
  listProjects(caller: CallerContext, input: ListProjectsInput): Promise<ListProjectsOutput>;
  publish(caller: CallerContext, input: PublishInput): Promise<PublishOutput>;
}
