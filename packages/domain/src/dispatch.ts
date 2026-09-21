// A dispatch is one hand-off: the console picks ready items, a node, an agent
// and a mode; the node pulls the request and starts one session for the whole
// batch. The session then works the items through MCP like any other agent, so
// the item status still moves only through claim and submit, never through a
// dispatch. Item status and execution status stay separate.

export const AGENT_KINDS = ["claude_code", "codex", "hermes"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// Only the modes a session can be started in unattended. bypassPermissions and
// dontAsk are deliberately absent: a dispatched session runs with nobody at the
// machine, so the two modes that remove the human from the loop are exactly the
// two that must not be reachable from a web form.
export const CLAUDE_CODE_MODES = ["plan", "default", "acceptEdits", "auto"] as const;
export type ClaudeCodeMode = (typeof CLAUDE_CODE_MODES)[number];

// Codex has no permission modes of its own to pass through; each of these is a
// fixed combination the node applies when it starts the thread. All three keep
// the workspace-write sandbox and on-request approvals:
// - plan: the session presents a plan and waits for human approval before any
//   writes; technical sandbox approvals use auto-review independently.
// - default: sandbox escapes are approved by a person in the Codex app.
// - auto: sandbox escapes go to Codex's own auto-review instead of a person.
// The approval policy `never` and the `danger-full-access` sandbox are
// deliberately unreachable, for the same reason as bypassPermissions above.
export const CODEX_MODES = ["plan", "default", "auto"] as const;
export type CodexMode = (typeof CODEX_MODES)[number];

export const DISPATCH_MODES_BY_AGENT: Readonly<Record<AgentKind, readonly string[]>> = {
  claude_code: CLAUDE_CODE_MODES,
  codex: CODEX_MODES,
  hermes: [],
};

export function isSupportedDispatchMode(agentKind: AgentKind, mode: string): boolean {
  return DISPATCH_MODES_BY_AGENT[agentKind].includes(mode);
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
