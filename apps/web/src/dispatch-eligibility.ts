import { AGENT_KINDS, CLAUDE_CODE_MODES, CODEX_MODES, OPENCODE_MODES, DISPATCH_STATUSES, isCodexThreadLink, type AgentKind } from "@missiongo/domain";

import type { MessageKey } from "./i18n";
import type { DispatchNode, Product, WorkItemStatus } from "./types";

/**
 * Only work that is waiting can be dispatched. An item already in progress has
 * a session on it, and one in verification has had its answer; sending either to
 * a second machine gets two sessions writing the same branch. The server rejects
 * the same thing, but the list has to say so before the click rather than after.
 */
export function isDispatchable(status: WorkItemStatus): boolean {
  return status === "ready";
}

/**
 * Product access is omitted by older servers, where AI dispatch was available
 * to every signed-in account. Keep that compatibility for a known product, but
 * do not expose AI controls while the product itself is still unknown.
 */
export function productAllowsAi(product: Product | undefined): boolean {
  return Boolean(product && product.access?.canUseAi !== false);
}

/**
 * Whether a row can be ticked at all. Three batch actions exist: dispatching
 * waiting work, closing verification on several items at once (AND-66), and
 * putting in-progress work back to ready (AND-160).
 */
export function isSelectable(status: WorkItemStatus): boolean {
  return isDispatchable(status) || status === "pending_verification" || status === "in_progress";
}

/**
 * Whether this row can join the current selection. A batch is one action, and
 * the two batch actions apply to different statuses, so a selection holds items
 * of one status only: once something is ticked, rows of the other status wait.
 */
export function canJoinSelection(status: WorkItemStatus, selectionStatus: WorkItemStatus | undefined): boolean {
  return isSelectable(status) && (selectionStatus === undefined || selectionStatus === status);
}

/**
 * Ticking a row. Rows that cannot join are dropped rather than refused loudly:
 * their checkbox is already disabled, so this only guards the paths that do not
 * go through it (a keyboard activation on a stale row, a restored selection).
 *
 * `selectionStatus` is the status of what is already ticked; leave it out when
 * nothing is.
 */
export function toggleItemSelection(
  selected: ReadonlySet<string>,
  item: { readonly key: string; readonly status: WorkItemStatus },
  selectionStatus?: WorkItemStatus,
): ReadonlySet<string> {
  if (selected.has(item.key)) {
    const next = new Set(selected);
    next.delete(item.key);
    return next;
  }
  if (!canJoinSelection(item.status, selected.size === 0 ? undefined : selectionStatus)) return selected;
  const next = new Set(selected);
  if (!next.delete(item.key)) next.add(item.key);
  return next;
}

/**
 * What the list is currently showing, as one comparable value.
 *
 * A selection is about the rows on screen. Change the product or the status and
 * those rows are gone, so carrying the ticks over would mean dispatching items
 * nobody can see — and across products, items whose repository is not even the
 * one the batch would run in. Every filter counts, not just the two that hide
 * the most: a type or search change removes rows just as completely.
 */
export function selectionScope(filters: {
  readonly productId: string;
  readonly status: string;
  readonly type: string;
  readonly search: string;
}): string {
  return [filters.productId, filters.status, filters.type, filters.search.trim()].join("\u0000");
}

export type NodeIneligibility =
  | { readonly reason: "revoked" }
  | { readonly reason: "offline" }
  | { readonly reason: "agent_unavailable" }
  | { readonly reason: "agent_not_ready"; readonly unavailableReason?: string }
  | { readonly reason: "repo_unmapped"; readonly productIds: readonly string[] }
  | { readonly reason: "repo_conflict"; readonly repoPaths: readonly string[] };

/**
 * Why this machine cannot take this batch, or null when it can.
 *
 * Checked here as well as on the server because a queued dispatch a machine can
 * never run fails out of sight: the console would report work as sent while
 * nothing ever starts. The order is the order a person can act on — a revoked or
 * silent machine is not worth reporting a missing repository for.
 */
export function nodeIneligibility(
  node: DispatchNode,
  batch: { readonly productIds: readonly string[]; readonly agentKind: AgentKind },
): NodeIneligibility | null {
  if (node.revokedAt) return { reason: "revoked" };
  if (!node.online) return { reason: "offline" };
  const agent = node.agents.find((candidate) => candidate.kind === batch.agentKind);
  if (!agent) return { reason: "agent_unavailable" };
  // `ready` is absent from an older client and the server's own gate is
  // `ready !== false`, so absent means ready here too. The machine's wording for
  // why it paused travels with the report and names what to fix on that Mac, so
  // it is kept rather than replaced.
  if (agent.ready === false) {
    return agent.unavailableReason
      ? { reason: "agent_not_ready", unavailableReason: agent.unavailableReason }
      : { reason: "agent_not_ready" };
  }

  const unmapped: string[] = [];
  const repoPaths = new Set<string>();
  for (const productId of new Set(batch.productIds)) {
    const repo = node.repos.find((candidate) => candidate.productId === productId);
    if (repo) repoPaths.add(repo.repoPath);
    else unmapped.push(productId);
  }
  if (unmapped.length > 0) return { reason: "repo_unmapped", productIds: unmapped };
  // One session works in one checkout, so a batch spanning two repositories has
  // no machine that can take it -- including this one. Two products mapped to
  // the same path are one repository and stay dispatchable.
  if (repoPaths.size > 1) return { reason: "repo_conflict", repoPaths: [...repoPaths] };
  return null;
}

const AGENT_LABEL_KEYS: Readonly<Record<AgentKind, MessageKey>> = {
  claude_code: "agentClaudeCode",
  codex: "agentCodex",
  opencode: "agentOpenCode",
  hermes: "agentHermes",
};

/** Hermes is listed so the choice is visible, and disabled. */
export const SUPPORTED_AGENT_KINDS: readonly AgentKind[] = ["claude_code", "codex", "opencode"];

type DispatchModeName = (typeof CLAUDE_CODE_MODES)[number] | (typeof CODEX_MODES)[number] | (typeof OPENCODE_MODES)[number];

// Codex borrows the Claude Code names for its three modes, so one label each is enough.
const MODE_LABEL_KEYS: Readonly<Record<DispatchModeName, MessageKey>> = {
  bypassPermissions: "dispatchModeBypassPermissions",
  plan: "dispatchModePlan",
  default: "dispatchModeDefault",
  acceptEdits: "dispatchModeAcceptEdits",
  auto: "dispatchModeAuto",
};

const DISPATCH_STATUS_LABEL_KEYS: Readonly<Record<(typeof DISPATCH_STATUSES)[number], MessageKey>> = {
  queued: "dispatchStatusQueued",
  delivered: "dispatchStatusDelivered",
  launched: "dispatchStatusLaunched",
  failed: "dispatchStatusFailed",
  cancelled: "dispatchStatusCancelled",
};

export const NODE_INELIGIBILITY_KEYS: Readonly<Record<NodeIneligibility["reason"], MessageKey>> = {
  revoked: "nodeRevoked",
  offline: "nodeOffline",
  agent_unavailable: "nodeAgentMissing",
  // The fallback when the report carried no wording of its own; the machine's
  // reason is shown next to it whenever there is one.
  agent_not_ready: "nodeAgentNotReady",
  repo_unmapped: "nodeRepoUnmapped",
  repo_conflict: "nodeRepoConflict",
};

/**
 * The server's problem codes, said in a way that names the fix. Everything else
 * keeps the server's own title: a code this build has never heard of is more
 * honestly reported verbatim than folded into "something went wrong".
 */
const DISPATCH_PROBLEM_KEYS: Readonly<Record<string, MessageKey>> = {
  node_offline: "dispatchNodeOffline",
  node_revoked: "dispatchNodeRevoked",
  agent_unavailable: "dispatchAgentUnavailable",
  // The dialog could not know yet (AND-151); the server's title carries the
  // machine's own reason, which this wording keeps as the {reason}.
  agent_not_ready: "dispatchAgentNotReady",
  repo_unmapped: "dispatchRepoUnmapped",
  repo_conflict: "dispatchRepoConflict",
  item_not_dispatchable: "dispatchItemNotDispatchable",
  ai_not_permitted: "dispatchAiNotPermitted",
  // Only reached when the dialog did not know yet -- someone dispatched in the
  // meantime. The dialog refetches, so the notice and its checkbox appear.
  item_already_dispatched: "dispatchItemAlreadyDispatched",
};

/**
 * These three take the value as a plain string on purpose: they also label
 * timeline payloads and dispatch rows, which come back as whatever the server
 * wrote, and a build that predates a new agent or status must not crash on one.
 */
export function agentLabelKey(agentKind: string): MessageKey | null {
  return (AGENT_KINDS as readonly string[]).includes(agentKind)
    ? AGENT_LABEL_KEYS[agentKind as AgentKind]
    : null;
}

/**
 * One mode, said the way its agent says it. Agents borrow each other's mode
 * names, except OpenCode: its `default` runs the native Build agent, and
 * calling it "Default" in the console hid the one word OpenCode users know
 * the mode by (AND-189), so that agent gets the Build label.
 */
export function dispatchModeLabelKey(agentKind: string, mode: string): MessageKey | null {
  if (!Object.hasOwn(MODE_LABEL_KEYS, mode)) return null;
  if (agentKind === "opencode" && mode === "default") return "dispatchModeBuild";
  return MODE_LABEL_KEYS[mode as DispatchModeName];
}

/**
 * How a session link reads. A Codex thread has no web page: its link only opens
 * on a Mac with the Codex app, so it says so instead of promising a page.
 */
export function sessionLinkLabelKey(sessionUrl: string): MessageKey {
  return isCodexThreadLink(sessionUrl) ? "dispatchOpenInCodex" : "dispatchOpenSession";
}

/** Help under the mode picker, where the chosen mode does something worth explaining. */
export function dispatchModeHelpKey(agentKind: AgentKind, mode: string): MessageKey | null {
  if (agentKind === "claude_code" && mode === "bypassPermissions") return "dispatchBypassPermissionsHelp";
  if (mode === "plan") {
    return agentKind === "codex" ? "dispatchCodexPlanHelp" : agentKind === "opencode" ? "dispatchOpenCodePlanHelp" : "dispatchPlanHelp";
  }
  if (agentKind === "codex" && mode === "auto") return "dispatchCodexAutoHelp";
  return null;
}

export function dispatchStatusLabelKey(status: string): MessageKey | null {
  return (DISPATCH_STATUSES as readonly string[]).includes(status)
    ? DISPATCH_STATUS_LABEL_KEYS[status as (typeof DISPATCH_STATUSES)[number]]
    : null;
}

export function dispatchProblemKey(code: string): MessageKey | null {
  return DISPATCH_PROBLEM_KEYS[code] ?? null;
}

/**
 * Whether "start work" can offer handing this item to an AI, and if not, which
 * of the two reasons it is (AND-68). They need different people to fix them, so
 * they are never folded into one "not available":
 *
 * - `no_permission`: this account may not use AI on the product. Only an
 *   administrator (or the product's creator) can change that.
 * - `not_configured`: the permission is there, but no machine can take the item
 *   yet -- none connected, none with this product's repository mapped, none
 *   online, none running a supported agent, or none whose agent is ready. The
 *   account holder fixes the first four in Agent management; readiness heals
 *   itself once the machine's agent recovers.
 *
 * `access` absent means a server from before this field; the dispatch route
 * still refuses, so the choice is offered rather than hidden on a guess.
 */
export type AiAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "checking" }
  | { readonly kind: "no_permission" }
  | {
    readonly kind: "not_configured";
    readonly reason: "no_nodes" | "repo_unmapped" | "offline" | "agent_unavailable" | "agent_not_ready";
  };

export function aiAvailability(
  product: Pick<Product, "id" | "access"> | undefined,
  nodes: readonly DispatchNode[] | undefined,
): AiAvailability {
  if (product?.access && !product.access.canUseAi) return { kind: "no_permission" };
  if (!nodes) return { kind: "checking" };
  const live = nodes.filter((node) => !node.revokedAt);
  if (live.length === 0) return { kind: "not_configured", reason: "no_nodes" };
  const mapped = product ? live.filter((node) => node.repos.some((repo) => repo.productId === product.id)) : live;
  if (mapped.length === 0) return { kind: "not_configured", reason: "repo_unmapped" };
  const online = mapped.filter((node) => node.online);
  if (online.length === 0) return { kind: "not_configured", reason: "offline" };
  const reporting = online.filter((node) =>
    node.agents.some((agent) => SUPPORTED_AGENT_KINDS.includes(agent.kind)));
  if (reporting.length === 0) return { kind: "not_configured", reason: "agent_unavailable" };
  // A reported agent that is not ready is a different situation from a missing
  // one: the machine is there and the fix is on it, so it gets its own wording
  // instead of being told to install something it already has (AND-151).
  // `ready` absent is an older client, which the server treats as ready too.
  if (!reporting.some((node) =>
    node.agents.some((agent) => SUPPORTED_AGENT_KINDS.includes(agent.kind) && agent.ready !== false))) {
    return { kind: "not_configured", reason: "agent_not_ready" };
  }
  return { kind: "available" };
}
