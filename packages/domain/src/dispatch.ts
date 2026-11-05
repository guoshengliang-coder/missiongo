// A dispatch is one hand-off: the console picks ready items, a node, an agent
// and a mode; the node pulls the request and starts one session for the whole
// batch. The session then works the items through MCP like any other agent, so
// the item status still moves only through claim and submit, never through a
// dispatch. Item status and execution status stay separate.

export const AGENT_KINDS = ["claude_code", "codex", "opencode", "hermes"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// Client-native permissions are independent of implementation-plan approval.
export const CLAUDE_CODE_MODES = ["bypassPermissions", "plan", "default", "acceptEdits", "auto"] as const;
export type ClaudeCodeMode = (typeof CLAUDE_CODE_MODES)[number];
export const CODEX_MODES = ["default", "auto", "read-only", "full-access"] as const;
export type CodexMode = (typeof CODEX_MODES)[number];
export const OPENCODE_MODES = ["plan", "build"] as const;
export type OpenCodeMode = (typeof OPENCODE_MODES)[number];

/** Compatibility preserves the actual old policy; it never grants more access. */
export function normalizeAgentMode(agentKind: string, mode: string): string {
  if (agentKind === "codex" && mode === "plan") return "auto";
  if (agentKind === "opencode" && mode === "default") return "build";
  return mode;
}

export interface AgentModeCapability {
  readonly mode: string;
  readonly state: "available" | "unavailable" | "unknown";
  readonly reason?: string;
  /** Capability evidence is scoped to the resolved model/connection, not a name heuristic. */
  readonly model?: string;
}

export function agentModeCapability(agentKind: string, mode: string,
  capabilities?: readonly AgentModeCapability[], model?: string): AgentModeCapability {
  mode = normalizeAgentMode(agentKind, mode);
  // Full access remains disallowed by MissionGo's managed-workspace policy.
  if (agentKind === "codex" && mode === "full-access") return {
    mode, state: "unavailable", reason: "managed_workspace_required",
  };
  const evidence = capabilities?.find(entry => entry.mode === mode && entry.model === model)
    ?? (mode !== "auto" ? capabilities?.find(entry=>entry.mode===mode && entry.model===undefined) : undefined);
  if (evidence) return evidence;
  if (agentKind === "claude_code" && mode === "auto") return { mode, state: "unknown", reason: "native_capability_unconfirmed" };
  return { mode, state: "available" };
}

/** No saved choice is invented when Claude Auto availability is unknown. */
export function defaultAgentMode(agentKind: string, saved?: string,
  capabilities?: readonly AgentModeCapability[], model?: string): string {
  if (saved) return normalizeAgentMode(agentKind, saved);
  if (agentKind === "codex") return "auto";
  if (agentKind === "opencode") return "build";
  if (agentKind === "claude_code") {
    const auto = agentModeCapability(agentKind, "auto", capabilities, model);
    return auto.state === "available" ? "auto" : auto.state === "unavailable" ? "bypassPermissions" : "";
  }
  return "";
}

export const DISPATCH_MODES_BY_AGENT: Readonly<Record<AgentKind, readonly string[]>> = {
  claude_code: CLAUDE_CODE_MODES,
  codex: CODEX_MODES,
  opencode: OPENCODE_MODES,
  hermes: [],
};

export function isSupportedDispatchMode(agentKind: AgentKind, mode: string): boolean {
  return DISPATCH_MODES_BY_AGENT[agentKind].includes(normalizeAgentMode(agentKind, mode));
}

// A Codex thread has no web address; the Codex app opens it by id.
const CODEX_THREAD_LINK = /^codex:\/\/threads\/[A-Za-z0-9-]{1,100}$/;

/**
 * Whether a session link reported by a node may be stored and shown as a link.
 *
 * The value comes from a machine, not a person, and ends up in an `href`, so
 * only the two shapes a session actually has are accepted: an https address
 * (Claude Code) or a Codex thread link with nothing but an id after the prefix.
 * Anything else — `javascript:`, another custom scheme, a Codex link carrying a
 * path or query — is refused.
 */
export function isAcceptedSessionUrl(value: string): boolean {
  if (value.startsWith("https://")) return true;
  return CODEX_THREAD_LINK.test(value);
}

export function isCodexThreadLink(value: string): boolean {
  return CODEX_THREAD_LINK.test(value);
}

export const DISPATCH_STATUSES = ["queued", "delivered", "launched", "failed", "cancelled"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** Stable machine-readable reasons. Human copy stays in `error`. */
export const DISPATCH_FAILURE_CODES = [
  "skill_stale",
  "daemon_down",
  "daemon_environment",
  "resource_exhausted",
  "mcp_timeout",
  "mcp_auth",
  "cli_missing",
  "agent_auth_invalid",
  "unknown",
] as const;
export type DispatchFailureCode = (typeof DISPATCH_FAILURE_CODES)[number];

export const DISPATCH_FAILURE_STAGES = [
  "readiness",
  "preflight",
  "daemon",
  "mcp",
  "thread_start",
  "turn_start",
  "host_start",
  "unknown",
] as const;
export type DispatchFailureStage = (typeof DISPATCH_FAILURE_STAGES)[number];

export const AGENT_SKILL_SYNC_STATES = ["ready", "syncing", "failed", "missing", "stale", "unknown"] as const;
export type AgentSkillSyncState = (typeof AGENT_SKILL_SYNC_STATES)[number];

export interface AgentSkillSnapshot {
  readonly localVersion?: string;
  readonly expectedVersion?: string;
  readonly syncState: AgentSkillSyncState;
  readonly checkedAt?: string;
}

export interface AgentResourceSnapshot {
  readonly pid?: number;
  readonly openFiles?: number;
  readonly softLimit?: number;
  readonly source?: string;
  readonly checkedAt?: string;
  readonly status: "ready" | "unavailable" | "unknown";
  readonly reason?: string;
}

export interface DispatchDiagnosticSnapshot {
  /** A received result that failed validation, rather than a silent node. */
  readonly resultRejection?: {
    readonly receivedAt: string;
    readonly reason: string;
    readonly launchError?: string;
  };
  readonly nodeClientVersion?: string;
  readonly agentVersion?: string;
  readonly skill?: AgentSkillSnapshot;
  readonly resource?: AgentResourceSnapshot;
  /** App-server's thread-scoped view of the MissionGo MCP at launch time. */
  readonly mcp?: {
    readonly threadId?: string;
    readonly name: string;
    readonly startupStatus?: string;
    readonly runtimeStatus?: string;
    readonly authStatus?: string;
    readonly error?: string;
    readonly failureReason?: string;
    readonly observedAt: string;
  };
}

// A node that has not checked in for this long is treated as offline and cannot
// be dispatched to. Queueing work for a machine that is not listening looks the
// same as dispatching successfully until someone notices nothing ever started.
export const NODE_ONLINE_WINDOW_MS = 90_000;
export const NODE_STABLE_WINDOW_MS = 60_000;

export type NodeConnectionState = "online" | "unstable" | "offline";

/**
 * A missed heartbeat is not immediately an outage: laptops sleep and networks
 * roam. Surface the last 30 second grace period separately so the UI can warn
 * before the existing 90 second dispatch safety boundary is crossed.
 */
export function nodeConnectionState(
  lastSeenAt: string | undefined,
  now: number = Date.now(),
): NodeConnectionState {
  if (!lastSeenAt) return "offline";
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return "offline";
  const age = now - seen;
  if (age <= NODE_STABLE_WINDOW_MS) return "online";
  if (age <= NODE_ONLINE_WINDOW_MS) return "unstable";
  return "offline";
}

export function isNodeOnline(lastSeenAt: string | undefined, now: number = Date.now()): boolean {
  return nodeConnectionState(lastSeenAt, now) !== "offline";
}
