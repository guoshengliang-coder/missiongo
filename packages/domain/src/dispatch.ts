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

export const DISPATCH_MODES_BY_AGENT: Readonly<Record<AgentKind, readonly string[]>> = {
  claude_code: CLAUDE_CODE_MODES,
  codex: [],
  hermes: [],
};

export function isSupportedDispatchMode(agentKind: AgentKind, mode: string): boolean {
  return DISPATCH_MODES_BY_AGENT[agentKind].includes(mode);
}

export const DISPATCH_STATUSES = ["queued", "delivered", "launched", "failed", "cancelled"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

// A node that has not checked in for this long is treated as offline and cannot
// be dispatched to. Queueing work for a machine that is not listening looks the
// same as dispatching successfully until someone notices nothing ever started.
export const NODE_ONLINE_WINDOW_MS = 90_000;

export function isNodeOnline(lastSeenAt: string | undefined, now: number = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return false;
  return now - seen <= NODE_ONLINE_WINDOW_MS;
}
