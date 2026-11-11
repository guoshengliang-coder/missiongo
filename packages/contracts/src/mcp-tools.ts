import type { CommentAudienceInput } from "@missiongo/domain";
import type {
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
  { name:"request_collaboration_approval",access:"write",purpose:"Request a bound native-human approval to submit one exact collaboration draft." },
  { name:"request_merge_reconciliation_approval",access:"write",purpose:"Request a bound native-human decision for one exact prepared recovery, without executing it." },
  { name:"request_managed_decision_approval",access:"write",purpose:"Request a bound native-human approval of one existing managed decision version." },
  { name: "get_agent_artifact", access: "read", purpose: "Read only explicitly referenced conversation artifacts via protected storage." },
  { name: "get_review_content", access: "read", purpose: "Read complete version-bound plan, delivery, collaboration, recovery or managed-decision content without approval." },
  { name: "get_agent_history", access: "read", purpose: "Read one issued conversation-history page without input or execution." },
  { name: "get_merge_reconciliation", access: "read", purpose: "Preview original-batch Git facts, per-item handoffs and recovery blockers without mutation." },
  { name: "request_merge_reconciliation", access: "write", purpose: "Stage a snapshot-bound recovery action for human console approval; never grant authority." },
  { name: "apply_merge_reconciliation", access: "write", purpose: "Apply an approved recovery through the original batch conversation, retaining history." },
  { name: "record_merge_combined_validation", access: "write", purpose: "Bind final combined target validation to all current original-batch results." },
  { name: "get_merge_batch", access: "read", purpose: "Read the frozen selection from its authorized merge conversation." },
  { name: "propose_merge_delivery", access: "write", purpose: "Propose version-bound delivery for human confirmation without merging or changing item status." },
  { name: "refresh_merge_delivery", access: "write", purpose: "Refresh current Git evidence from the original development conversation." },
  { name: "report_merge_batch", access: "write", purpose: "Record a verified frozen merge result without claiming source items." },
  { name: "finish_merge_batch", access: "write", purpose: "Close a fully reconciled batch with no remaining external execution." },
  { name: "record_merge_integration", access: "write", purpose: "Record authorized batch planning, reserved repairs, validation and recovery progress." },
  {name:"get_collaboration_attachment",access:"read",purpose:"Read explicitly shared unchanged attachment evidence without source project access."},
  {name:"get_item_collaborations",access:"read",purpose:"Read scoped dependencies and approval drafts for one item."},
  {name:"list_collaboration_targets",access:"read",purpose:"List directed receiving grants without project or Git access."},
  {name:"get_collaboration",access:"read",purpose:"Read only approved request context, shared evidence and results."},
  {name:"prepare_collaboration_request",access:"write",purpose:"Prepare an idempotent draft for explicit human approval; creates no target item or dependency."},
  {name:"append_collaboration_discussion",access:"write",purpose:"Append shared discussion or receiving-side delivery evidence without state changes."},
  { name: "get_current_account", access: "read", purpose: "Confirm the connected account, its product read scope, and the expected Skill version." },
  { name: "list_products", access: "read", purpose: "List products visible to the connected account." },
  { name: "get_project_insights", access: "read", purpose: "Summarize authorized projects with explicit calendar periods and metric definitions." },
  { name: "list_project_insight_items", access: "read", purpose: "Page through items supporting a project flow metric." },
  { name: "get_item_status_checks", access: "read", purpose: "Read the named item's handover evidence and status-check results." },
  { name: "list_components", access: "read", purpose: "List components for a product." },
  { name: "list_items", access: "read", purpose: "Find work items using narrow product and status filters." },
  { name: "list_release_candidates", access: "read", purpose: "Find development-complete items with merged PRs in one authorized product for a verified release." },
  { name: "get_item_context", access: "read", purpose: "Load the complete structured context for one work item, including a source item linked by an active collaboration request." },
  { name: "get_item_timeline", access: "read", purpose: "Read comments, events, and execution summaries, including a collaboration-linked source item." },
  { name: "get_attachment", access: "read", purpose: "Obtain controlled access to one work item attachment, including a collaboration-linked source item." },
  { name: "get_comment_candidates", access: "read", purpose: "List eligible recipients within the user-named item project." },
  { name: "list_item_agent_sessions", access: "read", purpose: "List dispatch, project and external conversations verifiably linked to the user-named item, with rounds, sync state and known gaps." },
  { name: "get_agent_session", access: "read", purpose: "Page one linked conversation's merged transcript, execution records and attachments with explicit completeness limits." },
  { name: "get_item_plan_approvals", access: "read", purpose: "Read plan-message references and live approval assessments for linked conversations without ever proving an approval." },
  { name: "append_comment", access: "write", purpose: "Add one comment to a work item without changing anything a person wrote." },
  { name: "get_plan_document", access: "read", purpose: "Read the exact fixed Markdown and version with all covered item permissions." },
  { name: "prepare_plan_document", access: "write", purpose: "Save immutable plan Markdown and return the same summary and link for every client." },
  { name: "request_plan_approval", access: "write", purpose: "Request native human approval for the exact current implementation plan and validation scope; never an Agent-supplied approval fact." },
  { name: "claim_item", access: "write", purpose: "Claim ready work or join in-progress work within current Builder/executor authority using the original conversation identity. Claiming and implementation approval are independent; claiming does not authorize implementation. Explicit handoffs keep their separate authorization checks." },
  { name: "recover_execution_authorization", access: "write", purpose: "Recover only this original conversation's unrevoked claim credential in the current round, without claiming or changing status." },
  { name: "submit_development_complete", access: "write", purpose: "Record verified GitHub/GitLab or local Git integration and its release requirements, or an explicit reason no release is needed." },
  { name: "submit_non_release_for_verification", access: "write", purpose: "Submit explicitly no-release Git or local-change evidence for human verification using the original execution identity." },
  { name: "submit_for_verification", access: "write", purpose: "Hand published work over for a person to verify, recording evidence for every required artifact." },
  { name: "submit_release_batch", access: "write", purpose: "Hand a verified product release batch to verification with frozen candidate revisions and rounds, independently of developer sessions." },
  { name: "supplement_release_evidence", access: "write", purpose: "Append missing verified integration and complete release scope through the current authorized product conversation, preserving human events and frozen candidate checks." },
  { name: "supplement_non_release_evidence", access: "write", purpose: "Append historical local-tool no-release proof with product authority, preserving human status and exact delivery identity." },
  { name: "create_item", access: "write", purpose: "Record a follow-up split off from another item, or an independent item in a product, after the user approved its content (including the product) in the session." },
  { name: "upload_attachment_chunk", access: "write", purpose: "Stage a bounded chunk of a user-approved attachment in an authorized product." },
  { name: "prepare_attachment_upload", access: "write", purpose: "Authorize direct raw-byte upload for one user-approved file without passing bytes through model context." },
  { name: "add_item_attachment", access: "write", purpose: "Attach a completed upload to a user-named work item without editing its fields." },
  { name: "register_agent_session", access: "write", purpose: "Associate a user-directed external conversation with an item already being handled, without claiming or controlling it." },
  { name: "report_agent_session", access: "write", purpose: "Report factual external-session progress independently of work-item status." },
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

export interface ExternalAgentSessionIdentity {
  readonly autoConnect?: boolean;
  readonly agentKind: "codex" | "claude_code" | "opencode" | "hermes" | "other";
  readonly sessionRef: string;
  readonly refKind: "native" | "tracking";
  readonly name?: string;
}

export interface ClaimItemInput {
  readonly session?: ExternalAgentSessionIdentity;
  readonly dispatchId?: string;
  readonly itemKey: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
}

export interface CreateItemInput {
  /**
   * The item being worked on, for a related follow-up; the new item is created in
   * its product and linked to it. Give exactly one of sourceItemKey and productId.
   */
  readonly sourceItemKey?: string;
  /**
   * The product for an independent item (AND-134): an unrelated issue found while
   * working, or one the user asked for. Not linked to any item.
   */
  readonly productId?: string;
  readonly title: string;
  readonly description: string;
  readonly type: WorkItemType;
  readonly priority: WorkItemPriority;
  readonly status: "inbox" | "ready";
  /** Required when status is "ready". */
  readonly platform?: "android" | "macos" | "web" | "server" | "shared" | "other";
  readonly agentName?: string;
  readonly summary?: string;
  /** Completed uploads staged in the same product and owned by this connection. */
  readonly attachmentUploadIds?: readonly string[];
  readonly idempotencyKey: string;
}

export type CommentBodyKind = "structured" | "free";

export interface AppendCommentInput extends CommentAudienceInput {
  readonly sessionId?: string;
  readonly itemKey: string;
  readonly bodyKind: CommentBodyKind;
  /** Free-text body. */
  readonly text?: string;
  /** Structured body: what was understood, what was found, and what it rests on. */
  readonly understanding?: string;
  readonly finding?: string;
  readonly evidence?: readonly string[];
  readonly proposal?: string;
  readonly openQuestions?: readonly string[];
  /** Which AI on which machine, e.g. "Claude Code · studio-mac". Self-reported. */
  readonly agentName?: string;
  /** One line saying what the comment concludes, shown before the body is opened. */
  readonly summary?: string;
  readonly idempotencyKey: string;
}

export function findMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
