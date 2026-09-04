import type { ExecutionMode, ExecutionReport, TaskPriority, TaskStatus, TaskType } from "@feedback-system/domain";

export type McpToolAccess = "read" | "write";

export interface McpToolDefinition {
  readonly name: string;
  readonly access: McpToolAccess;
  readonly purpose: string;
}

export const MCP_TOOL_DEFINITIONS = [
  { name: "list_products", access: "read", purpose: "List products visible to the current token." },
  { name: "list_components", access: "read", purpose: "List components for a product." },
  { name: "list_tasks", access: "read", purpose: "Find tasks using narrow product and status filters." },
  { name: "get_task_context", access: "read", purpose: "Load the complete structured context for one task." },
  { name: "get_task_timeline", access: "read", purpose: "Read comments, events, and execution summaries." },
  { name: "get_attachment", access: "read", purpose: "Obtain controlled access to one task attachment." },
  { name: "get_execution", access: "read", purpose: "Read one AI execution record." },
  { name: "claim_task", access: "write", purpose: "Atomically claim a task and create a lease." },
  { name: "renew_task_lease", access: "write", purpose: "Renew an active task lease." },
  { name: "append_analysis", access: "write", purpose: "Append analysis without changing task status." },
  { name: "append_progress", access: "write", purpose: "Append a concise, user-visible progress milestone." },
  { name: "request_human_input", access: "write", purpose: "Ask a concrete question and wait for a human." },
  { name: "submit_resolution", access: "write", purpose: "Store a structured processing report." },
  {
    name: "mark_ready_for_verification",
    access: "write",
    purpose: "Move a processed task to human verification.",
  },
  { name: "release_task", access: "write", purpose: "Release a task without discarding its history." },
  { name: "resume_execution", access: "write", purpose: "Resume an interrupted or unblocked execution." },
] as const satisfies readonly McpToolDefinition[];

export interface ListTasksInput {
  readonly productId: string;
  readonly statuses?: readonly TaskStatus[];
  readonly types?: readonly TaskType[];
  readonly priorities?: readonly TaskPriority[];
  readonly componentIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GetTaskContextInput {
  readonly taskKey: string;
}

export interface ClaimTaskInput {
  readonly taskKey: string;
  readonly agentId: string;
  readonly mode: Extract<ExecutionMode, "process" | "continue" | "verify">;
  readonly leaseSeconds: number;
  readonly idempotencyKey: string;
}

export interface ClaimTaskResult {
  readonly executionId: string;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export interface AppendAnalysisInput {
  readonly taskKey: string;
  readonly agentId: string;
  readonly conclusion: string;
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly idempotencyKey: string;
}

export interface SubmitResolutionInput {
  readonly taskKey: string;
  readonly executionId: string;
  readonly leaseId: string;
  readonly report: ExecutionReport;
  readonly idempotencyKey: string;
}

export function findMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
