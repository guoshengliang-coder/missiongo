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
  { name: "get_current_account", access: "read", purpose: "Confirm the connected account, its product read scope, and the expected Skill version." },
  { name: "list_products", access: "read", purpose: "List products visible to the connected account." },
  { name: "list_components", access: "read", purpose: "List components for a product." },
  { name: "list_items", access: "read", purpose: "Find work items using narrow product and status filters." },
  { name: "get_item_context", access: "read", purpose: "Load the complete structured context for one work item." },
  { name: "get_item_timeline", access: "read", purpose: "Read comments, events, and execution summaries." },
  { name: "get_attachment", access: "read", purpose: "Obtain controlled access to one work item attachment." },
  { name: "append_comment", access: "write", purpose: "Add one comment to a work item without changing anything a person wrote." },
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

export type CommentBodyKind = "structured" | "free";

export interface AppendCommentInput {
  readonly itemKey: string;
  readonly bodyKind: CommentBodyKind;
  /** Free-text body. */
  readonly text?: string;
  /** Structured body. */
  readonly conclusion?: string;
  readonly evidence?: readonly string[];
  readonly risks?: readonly string[];
  readonly agentName?: string;
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
