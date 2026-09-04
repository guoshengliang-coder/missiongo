import type {
  ExecutionMode,
  ExecutionReport,
  WorkItemPriority,
  WorkItemStatus,
  WorkItemType,
} from "@missiongo/domain";

export type McpToolAccess = "read" | "write";

export interface McpToolDefinition {
  readonly name: string;
  readonly access: McpToolAccess;
  readonly purpose: string;
}

export const MCP_TOOL_DEFINITIONS = [
  { name: "list_products", access: "read", purpose: "List products visible to the current token." },
  { name: "list_components", access: "read", purpose: "List components for a product." },
  { name: "list_items", access: "read", purpose: "Find work items using narrow product and status filters." },
  { name: "get_item_context", access: "read", purpose: "Load the complete structured context for one work item." },
  { name: "get_item_timeline", access: "read", purpose: "Read comments, events, and execution summaries." },
  { name: "get_attachment", access: "read", purpose: "Obtain controlled access to one work item attachment." },
  { name: "get_execution", access: "read", purpose: "Read one AI execution record." },
  { name: "claim_item", access: "write", purpose: "Atomically claim a work item and create a lease." },
  { name: "renew_item_lease", access: "write", purpose: "Renew an active work item lease." },
  { name: "append_analysis", access: "write", purpose: "Append analysis without changing work item status." },
  { name: "append_progress", access: "write", purpose: "Append a concise, user-visible progress milestone." },
  { name: "request_human_input", access: "write", purpose: "Ask a concrete question and wait for a human." },
  { name: "submit_resolution", access: "write", purpose: "Store a structured processing report." },
  {
    name: "mark_pending_verification",
    access: "write",
    purpose: "Move a processed work item to human verification.",
  },
  { name: "release_item", access: "write", purpose: "Release a work item without discarding its history." },
  { name: "resume_execution", access: "write", purpose: "Resume an interrupted or unblocked execution." },
] as const satisfies readonly McpToolDefinition[];

export interface ListItemsInput {
  readonly productId: string;
  readonly statuses?: readonly WorkItemStatus[];
  readonly types?: readonly WorkItemType[];
  readonly priorities?: readonly WorkItemPriority[];
  readonly componentIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GetItemContextInput {
  readonly itemKey: string;
}

export interface ClaimItemInput {
  readonly itemKey: string;
  readonly agentId: string;
  readonly mode: Extract<ExecutionMode, "process" | "continue" | "verify">;
  readonly leaseSeconds: number;
  readonly idempotencyKey: string;
}

export interface ClaimItemResult {
  readonly executionId: string;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export interface AppendAnalysisInput {
  readonly itemKey: string;
  readonly agentId: string;
  readonly conclusion: string;
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly idempotencyKey: string;
}

export interface SubmitResolutionInput {
  readonly itemKey: string;
  readonly executionId: string;
  readonly leaseId: string;
  readonly report: ExecutionReport;
  readonly idempotencyKey: string;
}

export function findMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
