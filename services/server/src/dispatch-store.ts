import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  AGENT_KINDS,
  AGENT_SKILL_SYNC_STATES,
  DISPATCH_FAILURE_CODES,
  DISPATCH_FAILURE_STAGES,
  isAcceptedSessionUrl,
  isNodeOnline,
  isSupportedDispatchMode,
  type AgentKind,
  type AgentResourceSnapshot,
  type AgentSkillSnapshot,
  type DispatchDiagnosticSnapshot,
  type DispatchFailureCode,
  type DispatchFailureStage,
} from "@missiongo/domain";

import { requireOfferedModel, type NodeAgentModel } from "./agent-settings.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export interface NodeAgentReport {
  readonly kind: AgentKind;
  readonly version?: string;
  /** Models this agent offers on the machine (AND-130); absent from clients that cannot choose one. */
  readonly models?: readonly NodeAgentModel[];
  readonly ready?: boolean;
  readonly unavailableReason?: string;
  readonly skill?: AgentSkillSnapshot;
  readonly resource?: AgentResourceSnapshot;
}

/** A checkout the machine reported it can already work in. */
export interface RepoCandidate {
  readonly path: string;
  readonly name: string;
  readonly lastUsedAt?: string;
}

export const MAX_REPO_CANDIDATES = 50;
export const DISPATCH_START_TIMEOUT_MS = 10 * 60 * 1_000;

export function deliveredDispatchTimedOut(deliveredAt: string | null | undefined, now = Date.now()): boolean {
  if (!deliveredAt) return false;
  const deliveredTime = Date.parse(deliveredAt);
  return Number.isFinite(deliveredTime) && now - deliveredTime >= DISPATCH_START_TIMEOUT_MS;
}

export interface NodeRepoMapping {
  readonly productId: string;
  readonly productKey: string;
  readonly repoPath: string;
}

export interface NodeSnapshot {
  readonly id: string;
  /** What to call this machine: the nickname when one is set, the device name otherwise. */
  readonly name: string;
  /** The Mac's own name, as the client reported it when signing in. */
  readonly deviceName: string;
  readonly nickname?: string;
  readonly hostname?: string;
  readonly clientVersion?: string;
  readonly expectedSkillVersion?: string;
  readonly agents: readonly NodeAgentReport[];
  readonly repos: readonly NodeRepoMapping[];
  readonly repoCandidates: readonly RepoCandidate[];
  readonly lastSeenAt?: string;
  readonly online: boolean;
  readonly revokedAt?: string;
  readonly createdAt: string;
}

export interface CreatedNodeCredential {
  readonly nodeId: string;
  readonly name: string;
  readonly token: string;
}

/** Where the dispatch dialog starts for one account (AND-130). Every field is optional. */
export interface DispatchDefaults {
  readonly nodeId?: string;
  readonly agentKind?: AgentKind;
  readonly agents: Partial<Record<AgentKind, { readonly mode?: string; readonly model?: string; readonly effort?: string }>>;
}

export interface DispatchSnapshot {
  readonly id: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly agentKind: AgentKind;
  readonly mode: string;
  readonly model?: string;
  readonly effort?: string;
  readonly status: string;
  readonly itemKeys: readonly string[];
  readonly sessionName?: string;
  readonly sessionUrl?: string;
  readonly agentSessionId?: string;
  readonly error?: string;
  readonly failureCode?: DispatchFailureCode;
  readonly failureStage?: DispatchFailureStage;
  readonly diagnosticSnapshot?: DispatchDiagnosticSnapshot;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly completedAt?: string;
  readonly archivedAt?: string;
}

export interface DispatchHealthGroup {
  readonly key: string;
  readonly total: number;
  readonly failed: number;
  readonly failureRate: number;
}

export interface DispatchHealthSnapshot {
  readonly windowDays: number;
  readonly total: number;
  readonly launched: number;
  readonly failed: number;
  readonly failureRate: number;
  readonly groups: {
    readonly nodes: readonly DispatchHealthGroup[];
    readonly agents: readonly DispatchHealthGroup[];
    readonly versions: readonly DispatchHealthGroup[];
    readonly codes: readonly DispatchHealthGroup[];
  };
  readonly recentFailures: readonly DispatchSnapshot[];
}

export interface DispatchJob {
  readonly dispatchId: string;
  /** What this machine is called, for naming the session: nickname, else device name. */
  readonly nodeName: string;
  readonly itemKeys: readonly string[];
  readonly repoPath: string;
  readonly agentKind: AgentKind;
  readonly mode: string;
  /** Absent: run with the machine's own configured model and effort. */
  readonly model?: string;
  readonly effort?: string;
  /**
   * Which session on these items this is: 1 for the first, 2 when one of them
   * already had a session, and so on (the highest across the batch). The
   * machine puts it in the session name so a second go does not share the
   * first one's name.
   */
  readonly round: number;
  /**
   * Items sent back after their work was handed over: a failed verification, or
   * reopened once done. Keys only, like `itemKeys`; what the session is told
   * about them is decided on the machine.
   */
  readonly reworkItemKeys: readonly string[];
}

interface NodeRow {
  id: string;
  account_id: string;
  name: string;
  nickname: string | null;
  hostname: string | null;
  client_version: string | null;
  expected_skill_version: string | null;
  agents_json: string;
  repo_candidates_json: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface DispatchRow {
  id: string;
  node_id: string;
  node_name: string;
  agent_kind: string;
  mode: string;
  model: string | null;
  effort: string | null;
  status: string;
  session_name: string | null;
  session_url: string | null;
  agent_session_id: string | null;
  error: string | null;
  failure_code: string | null;
  failure_stage: string | null;
  diagnostic_snapshot_json: string | null;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
}

function nodeTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const MAX_NICKNAME_LENGTH = 40;

/**
 * Empty clears the nickname. It becomes the prefix of every session name in
 * claude.ai, so it stays short and free of control characters, which would
 * break the one-line name there.
 */
function normalizeNickname(value: string | null): string | null {
  const nickname = (value ?? "").trim();
  if (!nickname) return null;
  if (nickname.length > MAX_NICKNAME_LENGTH) {
    throw invalidInput(`Nickname must be ${MAX_NICKNAME_LENGTH} characters or fewer.`);
  }
  for (let position = 0; position < nickname.length; position += 1) {
    const code = nickname.charCodeAt(position);
    if (code <= 0x1f || code === 0x7f) throw invalidInput("Nickname cannot contain control characters.");
  }
  return nickname;
}

function text(value: string | undefined, field: string, maxLength: number): string {
  const normalized = (value ?? "").trim();
  if (!normalized) throw invalidInput(`${field} is required.`);
  if (normalized.length > maxLength) throw invalidInput(`${field} must be ${maxLength} characters or fewer.`);
  return normalized;
}

/**
 * Machines, their per-product checkouts, and the dispatches handed to them.
 *
 * Everything here is scoped by account: every read and write takes the account
 * id and filters on it, rather than trusting a caller to have filtered already.
 * There is one admin account today, so the filter changes nothing that can be
 * observed — which is exactly why it has to be written now. Added later, after
 * a second account exists, it would be a migration of live data instead of a
 * WHERE clause.
 */
/** Which products a caller may see mappings for: all of them, or these ids. */
type ProductScope = "*" | readonly string[];

export class DispatchStore {
  private readonly database: MissionGoDatabase;

  /**
   * Machines waiting on a long poll, by node id.
   *
   * A queued dispatch wakes its machine's waiter instead of making every machine
   * ask every few seconds. The waiters are in memory on purpose: a restart drops
   * them, the polls time out, and the machines ask again — the queue itself is
   * in SQLite, so nothing is lost by forgetting who was listening.
   */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(database: MissionGoDatabase) {
    this.database = database;
  }

  /**
   * Resolve once this node has work or the deadline passes. Returning on the
   * timeout rather than hanging forever is what keeps a dead connection from
   * looking like an idle one to either side.
   */
  async waitForDispatch(nodeId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (timeoutMs <= 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.waiters.get(nodeId)?.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      // Never hold the process open: an idle poll must not delay a shutdown.
      timer.unref?.();
      signal?.addEventListener("abort", finish, { once: true });
      const existing = this.waiters.get(nodeId) ?? new Set<() => void>();
      existing.add(finish);
      this.waiters.set(nodeId, existing);
    });
  }

  private wake(nodeId: string): void {
    const waiting = this.waiters.get(nodeId);
    if (!waiting) return;
    this.waiters.delete(nodeId);
    for (const resolve of waiting) resolve();
  }

  /**
   * Register the Mac a signed-in person is using, or hand that same Mac a fresh
   * credential.
   *
   * The installation id is what makes it the same Mac. Logging in again — after
   * signing out, or after the node was revoked — keeps the row, and with it the
   * repository mapping and the dispatch history, instead of leaving an orphan
   * behind every login. The old credential stops working in the same statement
   * that issues the new one, so a copy of it on disk is worth nothing afterwards.
   *
   * Signing in is the person's intent to use this Mac, so it also undoes a
   * revoke. What a revoke must not survive is the old token, and it does not.
   */
  registerNode(input: {
    accountId: string;
    installationId: string;
    name: string;
    hostname?: string;
  }): CreatedNodeCredential {
    const installationId = text(input.installationId, "Installation ID", 100);
    if (!/^[A-Za-z0-9-]{8,100}$/.test(installationId)) throw invalidInput("Installation ID is not valid.");
    const name = text(input.name, "Node name", 100);
    const hostname = input.hostname?.trim().slice(0, 255) || null;

    return this.database.transaction(() => {
      const now = new Date().toISOString();
      const token = `mgn_${randomBytes(32).toString("base64url")}`;
      const existing = this.database.connection
        .prepare("SELECT id, nickname FROM nodes WHERE account_id = ? AND installation_id = ?")
        .get(input.accountId, installationId) as unknown as { id: string; nickname: string | null } | undefined;

      if (existing) {
        this.database.connection
          .prepare(
            `UPDATE nodes SET token_hash = ?, name = ?, hostname = ?, revoked_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(nodeTokenHash(token), name, hostname, now, existing.id);
        // The device name follows the Mac, which may have been renamed since; a
        // nickname is the person's choice and survives signing in again.
        return { nodeId: existing.id, name: existing.nickname ?? name, token };
      }

      const nodeId = randomUUID();
      this.database.connection
        .prepare(
          `INSERT INTO nodes (id, account_id, installation_id, name, hostname, token_hash, agents_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
        )
        .run(nodeId, input.accountId, installationId, name, hostname, nodeTokenHash(token), now, now);
      return { nodeId, name, token };
    });
  }

  /** Everything the client shows about the machine it is running on. */
  describeSelf(nodeId: string, products: readonly { id: string; keyPrefix: string; name: string }[]): {
    node: {
      id: string;
      name: string;
      deviceName: string;
      nickname?: string;
      hostname?: string;
      online: boolean;
      lastSeenAt?: string;
    };
    repos: readonly NodeRepoMapping[];
    products: readonly { id: string; keyPrefix: string; name: string }[];
  } {
    const row = this.nodeRow(nodeId);
    const node = this.mapNode(row, products.map((product) => product.id));
    return {
      node: {
        id: node.id,
        name: node.name,
        deviceName: node.deviceName,
        ...(node.nickname ? { nickname: node.nickname } : {}),
        ...(node.hostname ? { hostname: node.hostname } : {}),
        online: node.online,
        ...(node.lastSeenAt ? { lastSeenAt: node.lastSeenAt } : {}),
      },
      repos: node.repos,
      products,
    };
  }

  /** The client's own mapping edit; the same rules as the console's. */
  replaceOwnRepos(
    nodeId: string,
    repos: readonly { productId: string; repoPath: string }[],
    visibleProductIds: ProductScope = "*",
  ): readonly NodeRepoMapping[] {
    return this.replaceRepos(this.nodeRow(nodeId).account_id, nodeId, repos, visibleProductIds);
  }

  listDispatchesForNode(nodeId: string, limit = 20): readonly DispatchSnapshot[] {
    const rows = this.database.connection
      .prepare(
        `SELECT d.id, d.node_id, COALESCE(n.nickname, n.name) AS node_name, d.agent_kind, d.mode, d.model, d.effort, d.status,
                d.session_name, d.session_url, s.id AS agent_session_id,
                d.error, d.failure_code, d.failure_stage, d.diagnostic_snapshot_json,
                d.created_at, d.delivered_at, d.completed_at, d.archived_at
         FROM dispatches d JOIN nodes n ON n.id = d.node_id
         LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
         WHERE d.node_id = ?
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(nodeId, limit) as unknown as DispatchRow[];
    return rows.map((row) => this.mapDispatch(row));
  }

  private nodeRow(nodeId: string): NodeRow {
    const row = this.database.connection
      .prepare(
        `SELECT id, account_id, name, nickname, hostname, client_version, expected_skill_version,
                agents_json, repo_candidates_json,
                last_seen_at, revoked_at, created_at
         FROM nodes WHERE id = ?`,
      )
      .get(nodeId) as unknown as NodeRow | undefined;
    if (!row) throw notFound("Node");
    return row;
  }

  authenticateNode(token: string): { nodeId: string; accountId: string } | undefined {
    const row = this.database.connection
      .prepare("SELECT id, account_id, revoked_at FROM nodes WHERE token_hash = ?")
      .get(nodeTokenHash(token)) as unknown as { id: string; account_id: string; revoked_at: string | null } | undefined;
    if (!row || row.revoked_at) return undefined;
    return { nodeId: row.id, accountId: row.account_id };
  }

  recordHeartbeat(
    nodeId: string,
    agents: readonly NodeAgentReport[],
    repoCandidates: readonly RepoCandidate[] = [],
    visibleProductIds: ProductScope = "*",
    metadata: { readonly clientVersion?: string; readonly expectedSkillVersion?: string; readonly supportsChatAttachments?: boolean } = {},
  ): readonly NodeRepoMapping[] {
    for (const agent of agents) {
      if (!AGENT_KINDS.includes(agent.kind)) throw invalidInput(`Unsupported agent kind: ${String(agent.kind)}.`);
      if (agent.skill && !AGENT_SKILL_SYNC_STATES.includes(agent.skill.syncState)) {
        throw invalidInput(`Unsupported Skill sync state: ${String(agent.skill.syncState)}.`);
      }
    }
    const normalizedAgents = agents.map((agent) => {
      const skillReady = !metadata.expectedSkillVersion
        || (agent.skill?.syncState === "ready" && agent.skill.localVersion === metadata.expectedSkillVersion);
      const ready = agent.ready !== false && skillReady && agent.resource?.status !== "unavailable";
      return {
        ...agent,
        ready,
        ...(!ready && !agent.unavailableReason
          ? { unavailableReason: skillReady ? agent.resource?.reason ?? "Agent readiness could not be verified." : "MissionGo Skill is not synchronized." }
          : {}),
      };
    });
    // The machine offers these so the console can present a list instead of a
    // path field. They are a convenience, not a permission: a mapping is still
    // only what a person saved, and a path outside this list can still be typed.
    const candidates = repoCandidates
      .filter((candidate) => candidate.path.startsWith("/"))
      .slice(0, MAX_REPO_CANDIDATES)
      .map((candidate) => ({
        path: candidate.path.slice(0, 500),
        name: candidate.name.slice(0, 200),
        ...(candidate.lastUsedAt ? { lastUsedAt: candidate.lastUsedAt } : {}),
      }));
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `UPDATE nodes SET agents_json = ?, repo_candidates_json = ?, client_version = ?, expected_skill_version = ?, supports_chat_attachments = ?,
                          last_seen_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(normalizedAgents), JSON.stringify(candidates),
        metadata.clientVersion?.slice(0, 100) || null,
        metadata.expectedSkillVersion?.slice(0, 100) || null,
        metadata.supportsChatAttachments ? 1 : 0,
        now, now, nodeId,
      );
    return this.listRepos(nodeId, visibleProductIds);
  }

  listNodes(accountId: string, visibleProductIds: ProductScope = "*"): readonly NodeSnapshot[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, account_id, name, nickname, hostname, client_version, expected_skill_version,
                agents_json, repo_candidates_json,
                last_seen_at, revoked_at, created_at
         FROM nodes WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(accountId) as unknown as NodeRow[];
    return rows.map((row) => this.mapNode(row, visibleProductIds));
  }

  getNode(accountId: string, nodeId: string): NodeSnapshot {
    const row = this.database.connection
      .prepare(
        `SELECT id, account_id, name, nickname, hostname, client_version, expected_skill_version,
                agents_json, repo_candidates_json,
                last_seen_at, revoked_at, created_at
         FROM nodes WHERE id = ? AND account_id = ?`,
      )
      .get(nodeId, accountId) as unknown as NodeRow | undefined;
    if (!row) throw notFound("Node");
    return this.mapNode(row);
  }

  /**
   * Set or clear what this machine is called. One nickname, editable from the
   * console and from the Mac itself: two names for one machine would be two
   * places for them to disagree. Clearing it goes back to the device name.
   */
  setNickname(accountId: string, nodeId: string, nickname: string | null): NodeSnapshot {
    this.getNode(accountId, nodeId);
    this.database.connection
      .prepare("UPDATE nodes SET nickname = ?, updated_at = ? WHERE id = ? AND account_id = ?")
      .run(normalizeNickname(nickname), new Date().toISOString(), nodeId, accountId);
    return this.getNode(accountId, nodeId);
  }

  /** The client's own nickname edit; the same rules as the console's. */
  setOwnNickname(nodeId: string, nickname: string | null): NodeSnapshot {
    return this.setNickname(this.nodeRow(nodeId).account_id, nodeId, nickname);
  }

  revokeNode(accountId: string, nodeId: string): void {
    this.getNode(accountId, nodeId);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.connection
        .prepare("UPDATE nodes SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now, now, nodeId);
      // Work already handed over cannot be recalled, but work still queued for a
      // machine that will never pull again would sit as "queued" forever and read
      // as "about to start".
      this.database.connection
        .prepare("UPDATE dispatches SET status = 'cancelled', completed_at = ?, error = ? WHERE node_id = ? AND status = 'queued'")
        .run(now, "节点已撤销", nodeId);
    });
  }

  /**
   * Replace a machine's mapping for the products the caller can see.
   *
   * Only those: a mapping for a product the account has since lost access to
   * is neither shown to it nor sent back by it, so replacing the whole table
   * would silently drop that row -- and requiring it in the request, as before,
   * made every later save fail with "product not found" instead.
   */
  replaceRepos(
    accountId: string,
    nodeId: string,
    repos: readonly { productId: string; repoPath: string }[],
    visibleProductIds: ProductScope = "*",
  ): readonly NodeRepoMapping[] {
    this.getNode(accountId, nodeId);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      if (visibleProductIds === "*") {
        this.database.connection.prepare("DELETE FROM node_product_repos WHERE node_id = ?").run(nodeId);
      } else {
        const remove = this.database.connection.prepare("DELETE FROM node_product_repos WHERE node_id = ? AND product_id = ?");
        for (const productId of visibleProductIds) remove.run(nodeId, productId);
      }
      const insert = this.database.connection.prepare(
        `INSERT INTO node_product_repos (id, node_id, product_id, repo_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const repo of repos) {
        const product = this.database.connection
          .prepare("SELECT id FROM products WHERE id = ?")
          .get(repo.productId) as unknown as { id: string } | undefined;
        if (!product) throw notFound("Product");
        const repoPath = text(repo.repoPath, "Repository path", 500);
        // The machine checks that the path is a git checkout it can use; the
        // server only checks the shape, because it cannot see that disk.
        if (!repoPath.startsWith("/")) throw invalidInput("Repository path must be absolute.");
        insert.run(randomUUID(), nodeId, repo.productId, repoPath, now, now);
      }
    });
    return this.listRepos(nodeId, visibleProductIds);
  }

  /** Every mapping by default; the console and the client pass what their account can see. */
  listRepos(nodeId: string, visibleProductIds: ProductScope = "*"): readonly NodeRepoMapping[] {
    const rows = this.database.connection
      .prepare(
        `SELECT r.product_id, r.repo_path, p.key_prefix
         FROM node_product_repos r JOIN products p ON p.id = r.product_id
         WHERE r.node_id = ? ORDER BY p.key_prefix`,
      )
      .all(nodeId) as unknown as Array<{ product_id: string; repo_path: string; key_prefix: string }>;
    return rows
      .filter((row) => visibleProductIds === "*" || visibleProductIds.includes(row.product_id))
      .map((row) => ({ productId: row.product_id, productKey: row.key_prefix, repoPath: row.repo_path }));
  }

  /**
   * Queue one batch for one machine.
   *
   * Everything that can be checked before the hand-off is checked here, because
   * a dispatch that fails on the machine fails out of sight: the console would
   * show work as sent while nothing ever starts. Hence ready-only items, one
   * repository per batch (one session cannot span two checkouts), an online
   * machine, and an agent that machine actually reported.
   */
  createDispatch(input: {
    accountId: string;
    nodeId: string;
    agentKind: AgentKind;
    mode: string;
    model?: string;
    effort?: string;
    itemKeys: readonly string[];
    /** Dispatch again even though an earlier dispatch of these items was never claimed. */
    force?: boolean;
  }, alreadyInTransaction = false): DispatchSnapshot {
    if (!AGENT_KINDS.includes(input.agentKind)) throw invalidInput("Unsupported agent kind.");
    if (!isSupportedDispatchMode(input.agentKind, input.mode)) {
      throw invalidInput(`Unsupported mode for this agent: ${input.mode}.`);
    }
    if (input.itemKeys.length === 0) throw invalidInput("Select at least one work item.");
    if (input.itemKeys.length > 20) throw invalidInput("A dispatch can carry at most 20 work items.");

    const create = () => {
      const node = this.getNode(input.accountId, input.nodeId);
      if (node.revokedAt) throw conflict("node_revoked", "This node was revoked.");
      if (!node.online) throw conflict("node_offline", "This node is not currently connected.");
      const agent = node.agents.find((entry) => entry.kind === input.agentKind);
      if (!agent) {
        throw conflict("agent_unavailable", "This node did not report that agent.");
      }
      if (agent.ready === false) {
        throw conflict("agent_not_ready", agent.unavailableReason ?? "This agent is not ready for dispatch.");
      }
      requireOfferedModel(input.agentKind, agent.models, {
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      });

      const keys = [...new Set(input.itemKeys.map((key) => key.trim().toUpperCase()))];
      const items = keys.map((key) => {
        const row = this.database.connection
          .prepare("SELECT id, item_key, status, product_id FROM work_items WHERE item_key = ?")
          .get(key) as unknown as { id: string; item_key: string; status: string; product_id: string } | undefined;
        if (!row) throw notFound(`Work item ${key}`);
        if (row.status !== "ready") {
          throw conflict("item_not_dispatchable", `${row.item_key} is not ready, so it cannot be dispatched.`);
        }
        return row;
      });

      // An item stays ready until a session claims it, and in plan mode that is
      // only after a person approves the plan — minutes or hours after the
      // dispatch. Without this, the same item could be sent again in that window,
      // two sessions would plan it, and the one that lost the claim race had been
      // told to carry on anyway. Refuse unless the person says the earlier
      // session is gone.
      const active = this.dispatchesFor(items.map((item) => item.id));
      if (active.length > 0 && !input.force) {
        const described = active
          .map((entry) => `${entry.itemKey} → ${entry.nodeName}（${entry.status}）`)
          .join("、");
        throw conflict(
          "item_already_dispatched",
          `Already dispatched and not yet claimed: ${described}. Dispatch again only if that session is gone.`,
        );
      }

      const repos = this.listRepos(node.id);
      const repoPaths = new Set<string>();
      for (const item of items) {
        const repo = repos.find((entry) => entry.productId === item.product_id);
        if (!repo) throw conflict("repo_unmapped", `${item.item_key}'s product has no repository on this node.`);
        repoPaths.add(repo.repoPath);
      }
      if (repoPaths.size > 1) {
        throw conflict("repo_conflict", "One session works in one checkout; these items span several repositories.");
      }
      const repoPath = [...repoPaths][0]!;

      const now = new Date().toISOString();
      // Dispatching again on purpose: an earlier dispatch the machine has not
      // picked up yet would otherwise still start a second session the moment
      // that machine comes back. One already delivered cannot be recalled.
      if (input.force) {
        const queuedIds = [...new Set(active.filter((entry) => entry.status === "queued").map((entry) => entry.dispatchId))];
        const cancel = this.database.connection.prepare(
          "UPDATE dispatches SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ? AND status = 'queued'",
        );
        for (const queuedId of queuedIds) cancel.run(now, "已被重新派单取代", queuedId);
      }
      const dispatchId = randomUUID();
      const diagnosticSnapshot: DispatchDiagnosticSnapshot = {
        ...(node.clientVersion ? { nodeClientVersion: node.clientVersion } : {}),
        ...(agent.version ? { agentVersion: agent.version } : {}),
        ...(agent.skill ? { skill: agent.skill } : {}),
        ...(agent.resource ? { resource: agent.resource } : {}),
      };
      this.database.connection
        .prepare(
          `INSERT INTO dispatches
             (id, account_id, node_id, agent_kind, mode, model, effort, status, repo_path, diagnostic_snapshot_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          dispatchId, input.accountId, node.id, input.agentKind, input.mode,
          input.model ?? null, input.effort ?? null, repoPath, JSON.stringify(diagnosticSnapshot), now,
        );
      const insertItem = this.database.connection.prepare(
        "INSERT INTO dispatch_items (dispatch_id, item_id, position) VALUES (?, ?, ?)",
      );
      items.forEach((item, index) => insertItem.run(dispatchId, item.id, index));
      const created = this.getDispatch(input.accountId, dispatchId);
      // The machine is usually already waiting on a poll, so it picks this up in
      // well under a second rather than on its next scheduled ask.
      this.wake(node.id);
      return created;
    };
    return alreadyInTransaction ? create() : this.database.transaction(create);
  }

  /**
   * Dispatches of these items that may still become, or already are, a session
   * working on them: waiting for the machine, handed over, or launched. Callers
   * only ask about items that are still ready, so a launched dispatch here is one
   * whose session has not claimed the item.
   *
   * A dispatch whose item has been worked on since does not count, even though
   * the item is ready again: `launched` is where a dispatch stays for good, so an
   * item sent back by a failed verification would otherwise read as dispatched
   * and unclaimed forever, and could only go out again with force.
   */
  private dispatchesFor(itemIds: readonly string[], includeFailed = false): Array<{
    dispatchId: string;
    itemKey: string;
    nodeName: string;
    status: string;
    createdAt: string;
  }> {
    if (itemIds.length === 0) return [];
    const placeholders = itemIds.map(() => "?").join(", ");
    return this.database.connection
      .prepare(
        `SELECT d.id AS dispatch_id, w.item_key, COALESCE(n.nickname, n.name) AS node_name, d.status, d.created_at
         FROM dispatch_items di
         JOIN dispatches d ON d.id = di.dispatch_id
         JOIN nodes n ON n.id = d.node_id
         JOIN work_items w ON w.id = di.item_id
         WHERE di.item_id IN (${placeholders}) AND d.status IN (${includeFailed
           ? "'queued', 'delivered', 'launched', 'failed'"
           : "'queued', 'delivered', 'launched'"})
           AND NOT EXISTS (
             SELECT 1 FROM work_item_events e
             WHERE e.item_id = di.item_id AND e.created_at >= d.created_at
               AND e.to_status IN ('in_progress', 'development_complete', 'pending_verification', 'done')
           )
         ORDER BY d.created_at DESC`,
      )
      .all(...itemIds)
      .map((row) => {
        const record = row as { dispatch_id: string; item_key: string; node_name: string; status: string; created_at: string };
        return {
          dispatchId: record.dispatch_id,
          itemKey: record.item_key,
          nodeName: record.node_name,
          status: record.status,
          createdAt: record.created_at,
        };
      });
  }

  /**
   * For the console: ready items of this account that were dispatched and not
   * yet claimed, so the list can say so before anyone dispatches them again.
   */
  listActiveDispatches(accountId: string): Array<{
    dispatchId: string;
    itemKey: string;
    nodeName: string;
    status: string;
    createdAt: string;
  }> {
    const rows = this.database.connection
      .prepare(
        `SELECT DISTINCT w.id FROM dispatch_items di
         JOIN dispatches d ON d.id = di.dispatch_id
         JOIN work_items w ON w.id = di.item_id
         WHERE d.account_id = ? AND w.status = 'ready' AND d.status IN ('queued', 'delivered', 'launched')`,
      )
      .all(accountId) as unknown as Array<{ id: string }>;
    const byItem = new Map<string, ReturnType<DispatchStore["dispatchesFor"]>[number]>();
    // Newest first, so each item keeps its most recent dispatch.
    for (const entry of this.dispatchesFor(rows.map((row) => row.id))) {
      if (!byItem.has(entry.itemKey)) byItem.set(entry.itemKey, entry);
    }
    return [...byItem.values()];
  }

  /**
   * For the ready-item list: the newest dispatch result that still belongs to
   * this ready cycle. Failed attempts are included so the row does not silently
   * fall back to looking untouched; a newer retry naturally replaces one.
   */
  listLatestDispatches(accountId: string): Array<{
    dispatchId: string;
    itemKey: string;
    nodeName: string;
    status: string;
    createdAt: string;
  }> {
    const rows = this.database.connection
      .prepare(
        `SELECT DISTINCT w.id FROM dispatch_items di
         JOIN dispatches d ON d.id = di.dispatch_id
         JOIN work_items w ON w.id = di.item_id
         WHERE d.account_id = ? AND w.status = 'ready'
           AND d.status IN ('queued', 'delivered', 'launched', 'failed')`,
      )
      .all(accountId) as unknown as Array<{ id: string }>;
    const byItem = new Map<string, ReturnType<DispatchStore["dispatchesFor"]>[number]>();
    for (const entry of this.dispatchesFor(rows.map((row) => row.id), true)) {
      if (!byItem.has(entry.itemKey)) byItem.set(entry.itemKey, entry);
    }
    return [...byItem.values()];
  }

  /**
   * For the console: in-progress items claimed through a dispatch, so the list
   * and the detail can say which agent is on them. The claim event is the tie
   * between the two -- a launch nobody claimed (the person started the work
   * instead) must not read as that agent's.
   */
  listInProgressHandlers(accountId: string): Array<{
    dispatchId: string;
    itemKey: string;
    nodeName: string;
    agentKind: string;
    createdAt: string;
  }> {
    const rows = this.database.connection
      .prepare(
        `SELECT w.item_key, d.id AS dispatch_id, COALESCE(n.nickname, n.name) AS node_name, d.agent_kind, d.created_at
         FROM work_items w
         JOIN work_item_events claim ON claim.item_id = w.id
           AND claim.to_status = 'in_progress'
           AND claim.actor_kind = 'agent'
           AND claim.created_at = (
             SELECT MAX(latest.created_at) FROM work_item_events latest
             WHERE latest.item_id = w.id AND latest.to_status = 'in_progress'
           )
         JOIN dispatch_items di ON di.item_id = w.id
         JOIN dispatches d ON d.id = di.dispatch_id
           AND d.status = 'launched' AND d.created_at <= claim.created_at
         JOIN nodes n ON n.id = d.node_id
         WHERE d.account_id = ? AND w.status = 'in_progress'
         ORDER BY d.created_at DESC`,
      )
      .all(accountId) as unknown as Array<{
        item_key: string;
        dispatch_id: string;
        node_name: string;
        agent_kind: string;
        created_at: string;
      }>;
    const byItem = new Map<string, { dispatchId: string; itemKey: string; nodeName: string; agentKind: string; createdAt: string }>();
    for (const row of rows) {
      if (!byItem.has(row.item_key)) {
        byItem.set(row.item_key, {
          dispatchId: row.dispatch_id,
          itemKey: row.item_key,
          nodeName: row.node_name,
          agentKind: row.agent_kind,
          createdAt: row.created_at,
        });
      }
    }
    return [...byItem.values()];
  }

  /**
   * Hand the oldest queued dispatch to the machine asking for it. Marking it
   * delivered inside the same transaction is what keeps two polls from starting
   * the same batch twice.
   */
  claimNextDispatch(nodeId: string, availableAgentKinds?: readonly AgentKind[]): DispatchJob | undefined {
    if (availableAgentKinds?.length === 0) return undefined;
    return this.database.transaction(() => {
      const agentFilter = availableAgentKinds
        ? ` AND d.agent_kind IN (${availableAgentKinds.map(() => "?").join(", ")})`
        : "";
      const row = this.database.connection
        .prepare(
          `SELECT d.id, d.agent_kind, d.mode, d.model, d.effort, d.repo_path, COALESCE(n.nickname, n.name) AS node_name
           FROM dispatches d JOIN nodes n ON n.id = d.node_id
           WHERE d.node_id = ? AND d.status = 'queued'
             AND (d.retry_not_before IS NULL OR d.retry_not_before <= ?)${agentFilter}
           ORDER BY d.created_at LIMIT 1`,
        )
        .get(nodeId, new Date().toISOString(), ...(availableAgentKinds ?? [])) as unknown as
          {
            id: string; agent_kind: string; mode: string; model: string | null; effort: string | null;
            repo_path: string; node_name: string;
          } | undefined;
      if (!row) return undefined;
      const now = new Date().toISOString();
      this.database.connection
        .prepare("UPDATE dispatches SET status = 'delivered', delivered_at = ? WHERE id = ?")
        .run(now, row.id);
      return {
        dispatchId: row.id,
        itemKeys: this.listDispatchItemKeys(row.id),
        repoPath: row.repo_path,
        agentKind: row.agent_kind as AgentKind,
        mode: row.mode,
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        nodeName: row.node_name,
        round: this.dispatchRound(row.id),
        reworkItemKeys: this.listReworkItemKeys(row.id),
      };
    });
  }

  /**
   * One more than the most earlier dispatches any item of this batch had that
   * reached a machine. A queued dispatch that was cancelled, or one that failed
   * before a session started, left no session behind to be confused with, so
   * only delivered and launched ones count.
   */
  private dispatchRound(dispatchId: string): number {
    const row = this.database.connection
      .prepare(
        `SELECT MAX(earlier) AS earlier FROM (
           SELECT COUNT(prior.id) AS earlier
           FROM dispatch_items di
           JOIN dispatches d ON d.id = di.dispatch_id
           LEFT JOIN dispatch_items prior_item ON prior_item.item_id = di.item_id AND prior_item.dispatch_id <> d.id
           LEFT JOIN dispatches prior ON prior.id = prior_item.dispatch_id
             AND prior.created_at < d.created_at AND prior.status IN ('delivered', 'launched')
           WHERE di.dispatch_id = ?
           GROUP BY di.item_id
         )`,
      )
      .get(dispatchId) as unknown as { earlier: number | null };
    return (row.earlier ?? 0) + 1;
  }

  /** Items of this batch that were ever sent back from verification or from done, in batch order. */
  private listReworkItemKeys(dispatchId: string): readonly string[] {
    const rows = this.database.connection
      .prepare(
        `SELECT w.item_key FROM dispatch_items di JOIN work_items w ON w.id = di.item_id
         WHERE di.dispatch_id = ? AND EXISTS (
           SELECT 1 FROM work_item_events e
           WHERE e.item_id = di.item_id AND e.to_status = 'ready'
             AND e.from_status IN ('development_complete', 'pending_verification', 'done')
         )
         ORDER BY di.position`,
      )
      .all(dispatchId) as unknown as Array<{ item_key: string }>;
    return rows.map((row) => row.item_key);
  }

  recordDispatchResult(input: {
    nodeId: string;
    dispatchId: string;
    status: "launched" | "failed" | "retry";
    sessionName?: string;
    sessionUrl?: string;
    error?: string;
    failureCode?: DispatchFailureCode;
    failureStage?: DispatchFailureStage;
    retryAfterSeconds?: number;
    diagnosticSnapshot?: DispatchDiagnosticSnapshot;
  }): void {
    const row = this.database.connection
      .prepare("SELECT id, status, diagnostic_snapshot_json FROM dispatches WHERE id = ? AND node_id = ?")
      .get(input.dispatchId, input.nodeId) as unknown as {
        id: string; status: string; diagnostic_snapshot_json: string | null;
      } | undefined;
    if (!row) throw notFound("Dispatch");
    const sessionUrl = input.sessionUrl?.trim();
    // The URL is shown to a person as a link, so only accept one that a click
    // can safely follow: an https address, or a bare Codex thread link.
    if (sessionUrl && !isAcceptedSessionUrl(sessionUrl)) {
      throw invalidInput("Session URL must be an https:// address or a codex://threads/<id> link.");
    }
    if (input.failureCode && !DISPATCH_FAILURE_CODES.includes(input.failureCode)) {
      throw invalidInput("Unsupported dispatch failure code.");
    }
    if (input.failureStage && !DISPATCH_FAILURE_STAGES.includes(input.failureStage)) {
      throw invalidInput("Unsupported dispatch failure stage.");
    }
    if (row.status !== "delivered" && !(row.status === "launched" && input.status === "launched")) {
      throw conflict("dispatch_result_not_expected", "This dispatch no longer accepts a launch result.");
    }
    const now = new Date().toISOString();
    const existingDiagnostic = row.diagnostic_snapshot_json
      ? JSON.parse(row.diagnostic_snapshot_json) as DispatchDiagnosticSnapshot
      : {};
    const diagnosticSnapshot = input.diagnosticSnapshot
      ? { ...existingDiagnostic, ...input.diagnosticSnapshot }
      : undefined;
    if (input.status === "retry") {
      const retryAfterSeconds = Math.min(Math.max(input.retryAfterSeconds ?? 30, 5), 300);
      const retryNotBefore = new Date(Date.now() + retryAfterSeconds * 1_000).toISOString();
      this.database.connection
        .prepare(
          `UPDATE dispatches SET status = 'queued', delivered_at = NULL, completed_at = NULL,
                  error = ?, failure_code = ?, failure_stage = ?, diagnostic_snapshot_json = ?,
                  retry_not_before = ?, retry_count = retry_count + 1
           WHERE id = ?`,
        )
        .run(
          input.error?.slice(0, 2_000) || null,
          input.failureCode ?? "mcp_timeout",
          input.failureStage ?? "mcp",
          diagnosticSnapshot ? JSON.stringify(diagnosticSnapshot) : row.diagnostic_snapshot_json,
          retryNotBefore,
          input.dispatchId,
        );
      // Keep an already-open long poll asleep until the row is actually
      // claimable, then wake it on time. A process restart may forget this
      // timer, but the poll's own deadline still makes the node ask again.
      const timer = setTimeout(() => this.wake(input.nodeId), retryAfterSeconds * 1_000);
      timer.unref?.();
      return;
    }
    // A launch failure is something to come back for, so it moves the unread
    // clock (AND-135). A successful launch does not: the session's own first
    // message will.
    this.database.connection
      .prepare(
        `UPDATE dispatches SET status = ?, session_name = ?, session_url = ?, error = ?, failure_code = ?, failure_stage = ?, diagnostic_snapshot_json = COALESCE(?, diagnostic_snapshot_json), completed_at = ?,
                retry_not_before = NULL,
                unread_at = CASE WHEN ? = 'failed' THEN ? ELSE unread_at END
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.sessionName?.trim() || null,
        sessionUrl || null,
        input.error?.slice(0, 2_000) || null,
        input.status === "failed" ? input.failureCode ?? "unknown" : null,
        input.status === "failed" ? input.failureStage ?? "unknown" : null,
        diagnosticSnapshot ? JSON.stringify(diagnosticSnapshot) : null,
        now,
        input.status,
        now,
        input.dispatchId,
      );
  }

  getDispatch(accountId: string, dispatchId: string): DispatchSnapshot {
    const row = this.database.connection
      .prepare(
        `SELECT d.id, d.node_id, COALESCE(n.nickname, n.name) AS node_name, d.agent_kind, d.mode, d.model, d.effort, d.status,
                d.session_name, d.session_url, s.id AS agent_session_id,
                d.error, d.failure_code, d.failure_stage, d.diagnostic_snapshot_json,
                d.created_at, d.delivered_at, d.completed_at, d.archived_at
         FROM dispatches d JOIN nodes n ON n.id = d.node_id
         LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
         WHERE d.id = ? AND d.account_id = ?`,
      )
      .get(dispatchId, accountId) as unknown as DispatchRow | undefined;
    if (!row) throw notFound("Dispatch");
    return this.mapDispatch(row);
  }

  /** A Mac claimed this dispatch but never reported whether a session started. */
  retryDispatch(accountId: string, dispatchId: string): DispatchSnapshot {
    return this.database.transaction(() => {
      const original = this.getDispatch(accountId, dispatchId);
      if (original.status === "delivered") {
        if (original.agentSessionId || !deliveredDispatchTimedOut(original.deliveredAt)) {
          throw conflict("dispatch_not_retryable", "This dispatch is still starting or already has a session.");
        }
        const now = new Date().toISOString();
        const changed = this.database.connection.prepare(
          `UPDATE dispatches SET status = 'failed', completed_at = ?, error = ?, failure_code = 'unknown',
             failure_stage = 'thread_start', unread_at = ?
           WHERE id = ? AND account_id = ? AND status = 'delivered'
             AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE dispatch_id = ?)`,
        ).run(now, "Mac 领取派单后未报告启动结果；已手动请求重新派单。", now,
          dispatchId, accountId, dispatchId);
        if (changed.changes !== 1) throw conflict("dispatch_changed", "The dispatch changed before it could be retried.");
      } else if (original.status !== "failed" && original.status !== "cancelled") {
        throw conflict("dispatch_not_retryable", "Only failed, cancelled, or timed-out deliveries can be sent again.");
      }
      return this.createDispatch({
        accountId,
        nodeId: original.nodeId,
        agentKind: original.agentKind,
        mode: original.mode,
        ...(original.model ? { model: original.model } : {}),
        ...(original.effort ? { effort: original.effort } : {}),
        itemKeys: original.itemKeys,
      }, true);
    });
  }

  /**
   * Archive a completed hand-off that has no mirrored conversation. Mirrored
   * sessions keep using AgentSessionStore so pending commands and source-side
   * archive rules remain enforced in one place.
   */
  setArchived(accountId: string, dispatchId: string, archived: boolean): DispatchSnapshot {
    const dispatch = this.getDispatch(accountId, dispatchId);
    if (dispatch.agentSessionId) {
      throw conflict("dispatch_has_agent_session", "Archive this hand-off through its Agent session.");
    }
    if (!["launched", "failed", "cancelled"].includes(dispatch.status)) {
      throw conflict("dispatch_not_archivable", "This hand-off is still being delivered and cannot be archived yet.");
    }
    if (Boolean(dispatch.archivedAt) === archived) return dispatch;

    this.database.connection
      .prepare(
        `UPDATE dispatches
         SET archived_at = ?,
             auto_archive_suppressed = CASE WHEN ? = 0 AND archive_reason = 'auto' THEN 1 ELSE auto_archive_suppressed END,
             archive_reason = NULL
         WHERE id = ? AND account_id = ?`,
      )
      .run(archived ? new Date().toISOString() : null, archived ? 1 : 0, dispatchId, accountId);
    return this.getDispatch(accountId, dispatchId);
  }

  /** Cancel work that has not left the server yet. Once a Mac has claimed it,
   * the only truthful stop path is the agent-specific control channel. */
  cancelQueuedDispatch(accountId: string, dispatchId: string): DispatchSnapshot {
    const dispatch = this.getDispatch(accountId, dispatchId);
    if (dispatch.status !== "queued") {
      throw conflict("dispatch_already_delivered", "This dispatch has already left the server and cannot be recalled.");
    }
    const changed = this.database.connection
      .prepare(
        `UPDATE dispatches SET status = 'cancelled', completed_at = ?, error = ?
         WHERE id = ? AND account_id = ? AND status = 'queued'`,
      )
      .run(new Date().toISOString(), "已由控制台取消", dispatchId, accountId);
    if (changed.changes === 0) {
      throw conflict("dispatch_already_delivered", "This dispatch left the server before it could be cancelled.");
    }
    return this.getDispatch(accountId, dispatchId);
  }

  listDispatchesForItem(accountId: string, itemKey: string): readonly DispatchSnapshot[] {
    const rows = this.database.connection
      .prepare(
        `SELECT d.id, d.node_id, COALESCE(n.nickname, n.name) AS node_name, d.agent_kind, d.mode, d.model, d.effort, d.status,
                d.session_name, d.session_url, s.id AS agent_session_id,
                d.error, d.failure_code, d.failure_stage, d.diagnostic_snapshot_json,
                d.created_at, d.delivered_at, d.completed_at, d.archived_at
         FROM dispatches d
         JOIN nodes n ON n.id = d.node_id
         LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
         JOIN dispatch_items di ON di.dispatch_id = d.id
         JOIN work_items w ON w.id = di.item_id
         WHERE w.item_key = ? AND d.account_id = ?
         ORDER BY d.created_at DESC`,
      )
      .all(itemKey.toUpperCase(), accountId) as unknown as DispatchRow[];
    return rows.map((row) => this.mapDispatch(row));
  }

  dispatchHealth(accountId: string, windowDays = 7, visibleProductIds: ProductScope = "*"): DispatchHealthSnapshot {
    const days = Math.min(Math.max(Math.trunc(windowDays), 1), 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const visible = visibleProductIds === "*" ? undefined : visibleProductIds;
    const productClause = visible
      ? `AND EXISTS (
           SELECT 1 FROM dispatch_items scope_di JOIN work_items scope_w ON scope_w.id = scope_di.item_id
           WHERE scope_di.dispatch_id = d.id AND scope_w.product_id IN (${visible.map(() => "?").join(", ")})
         )`
      : "";
    if (visible?.length === 0) {
      return {
        windowDays: days, total: 0, launched: 0, failed: 0, failureRate: 0,
        groups: { nodes: [], agents: [], versions: [], codes: [] }, recentFailures: [],
      };
    }
    const rows = this.database.connection
      .prepare(
        `SELECT d.id, d.node_id, COALESCE(n.nickname, n.name) AS node_name, d.agent_kind, d.mode, d.model, d.effort, d.status,
                d.session_name, d.session_url, s.id AS agent_session_id,
                d.error, d.failure_code, d.failure_stage, d.diagnostic_snapshot_json,
                d.created_at, d.delivered_at, d.completed_at, d.archived_at
         FROM dispatches d JOIN nodes n ON n.id = d.node_id
         LEFT JOIN agent_sessions s ON s.dispatch_id = d.id
         WHERE d.account_id = ? AND d.created_at >= ?
         ${productClause}
         ORDER BY d.created_at DESC`,
      )
      .all(accountId, since, ...(visible ?? [])) as unknown as DispatchRow[];
    const completed = rows.filter((row) => row.status === "launched" || row.status === "failed");
    const failed = completed.filter((row) => row.status === "failed");
    const grouped = (keyFor: (row: DispatchRow) => string, source: readonly DispatchRow[] = completed): DispatchHealthGroup[] => {
      const buckets = new Map<string, { total: number; failed: number }>();
      for (const row of source) {
        const key = keyFor(row) || "unknown";
        const bucket = buckets.get(key) ?? { total: 0, failed: 0 };
        bucket.total += 1;
        if (row.status === "failed") bucket.failed += 1;
        buckets.set(key, bucket);
      }
      return [...buckets].map(([key, value]) => ({
        key,
        ...value,
        failureRate: value.total === 0 ? 0 : value.failed / value.total,
      })).sort((left, right) => right.failed - left.failed || right.total - left.total || left.key.localeCompare(right.key));
    };
    const diagnostic = (row: DispatchRow): DispatchDiagnosticSnapshot => row.diagnostic_snapshot_json
      ? JSON.parse(row.diagnostic_snapshot_json) as DispatchDiagnosticSnapshot
      : {};
    return {
      windowDays: days,
      total: completed.length,
      launched: completed.length - failed.length,
      failed: failed.length,
      failureRate: completed.length === 0 ? 0 : failed.length / completed.length,
      groups: {
        nodes: grouped((row) => row.node_name),
        agents: grouped((row) => row.agent_kind),
        versions: grouped((row) => {
          const snapshot = diagnostic(row);
          return [
            snapshot.nodeClientVersion && `client ${snapshot.nodeClientVersion}`,
            snapshot.agentVersion && `agent ${snapshot.agentVersion}`,
            snapshot.skill?.localVersion && `skill ${snapshot.skill.localVersion}`,
          ].filter(Boolean).join(" / ") || "unknown";
        }),
        codes: grouped((row) => row.failure_code ?? "unknown", failed),
      },
      recentFailures: failed.slice(0, 20).map((row) => this.mapDispatch(row)),
    };
  }

  listDispatchItemIds(dispatchId: string): readonly string[] {
    const rows = this.database.connection
      .prepare("SELECT item_id FROM dispatch_items WHERE dispatch_id = ? ORDER BY position")
      .all(dispatchId) as unknown as Array<{ item_id: string }>;
    return rows.map((row) => row.item_id);
  }

  private listDispatchItemKeys(dispatchId: string): readonly string[] {
    const rows = this.database.connection
      .prepare(
        `SELECT w.item_key FROM dispatch_items di JOIN work_items w ON w.id = di.item_id
         WHERE di.dispatch_id = ? ORDER BY di.position`,
      )
      .all(dispatchId) as unknown as Array<{ item_key: string }>;
    return rows.map((row) => row.item_key);
  }

  private mapNode(row: NodeRow, visibleProductIds: ProductScope = "*"): NodeSnapshot {
    return {
      id: row.id,
      name: row.nickname ?? row.name,
      deviceName: row.name,
      ...(row.nickname ? { nickname: row.nickname } : {}),
      ...(row.hostname ? { hostname: row.hostname } : {}),
      ...(row.client_version ? { clientVersion: row.client_version } : {}),
      ...(row.expected_skill_version ? { expectedSkillVersion: row.expected_skill_version } : {}),
      agents: JSON.parse(row.agents_json) as NodeAgentReport[],
      repos: this.listRepos(row.id, visibleProductIds),
      repoCandidates: row.repo_candidates_json
        ? JSON.parse(row.repo_candidates_json) as RepoCandidate[]
        : [],
      ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
      online: !row.revoked_at && isNodeOnline(row.last_seen_at ?? undefined),
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      createdAt: row.created_at,
    };
  }

  getDispatchDefaults(accountId: string): DispatchDefaults {
    const row = this.database.connection
      .prepare("SELECT settings_json FROM account_dispatch_defaults WHERE account_id = ?")
      .get(accountId) as unknown as { settings_json: string } | undefined;
    // New accounts start Claude Code dispatches in the explicitly chosen
    // MissionGo-only bypass mode. Existing saved choices are intentionally
    // preserved rather than silently changing a different account's policy.
    return row
      ? JSON.parse(row.settings_json) as DispatchDefaults
      : { agents: { claude_code: { mode: "bypassPermissions" } } };
  }

  /**
   * Checked for shape and for modes the agent has, not against any machine: the
   * machine may be asleep, and the dialog already falls back when a saved model
   * is no longer offered.
   */
  setDispatchDefaults(accountId: string, body: Record<string, unknown>): DispatchDefaults {
    const name = (value: unknown, field: string): string | undefined => {
      if (value === undefined || value === null || value === "") return undefined;
      if (typeof value !== "string" || value.length > 200) throw invalidInput(`${field} must be a short string.`);
      return value;
    };
    const agentKind = name(body.agentKind, "agentKind") as AgentKind | undefined;
    if (agentKind && !AGENT_KINDS.includes(agentKind)) throw invalidInput("Unsupported agent kind.");
    const agentsInput = body.agents ?? {};
    if (typeof agentsInput !== "object" || Array.isArray(agentsInput)) throw invalidInput("agents must be an object.");
    const agents: Record<string, { mode?: string; model?: string; effort?: string }> = {};
    for (const [kind, value] of Object.entries(agentsInput as Record<string, unknown>)) {
      if (!AGENT_KINDS.includes(kind as AgentKind)) throw invalidInput(`Unsupported agent kind: ${kind}.`);
      if (!value || typeof value !== "object") throw invalidInput("Each agent default must be an object.");
      const entry = value as Record<string, unknown>;
      const mode = name(entry.mode, "mode");
      if (mode && !isSupportedDispatchMode(kind as AgentKind, mode)) {
        throw invalidInput(`Unsupported mode for this agent: ${mode}.`);
      }
      const model = name(entry.model, "model");
      const effort = name(entry.effort, "effort");
      agents[kind] = { ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    }
    const nodeId = name(body.nodeId, "nodeId");
    if (nodeId) this.getNode(accountId, nodeId);
    const defaults: DispatchDefaults = {
      ...(nodeId ? { nodeId } : {}),
      ...(agentKind ? { agentKind } : {}),
      agents,
    };
    this.database.connection
      .prepare(
        `INSERT INTO account_dispatch_defaults (account_id, settings_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      )
      .run(accountId, JSON.stringify(defaults), new Date().toISOString());
    return defaults;
  }

  private mapDispatch(row: DispatchRow): DispatchSnapshot {
    return {
      id: row.id,
      nodeId: row.node_id,
      nodeName: row.node_name,
      agentKind: row.agent_kind as AgentKind,
      mode: row.mode,
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      status: row.status,
      itemKeys: this.listDispatchItemKeys(row.id),
      ...(row.session_name ? { sessionName: row.session_name } : {}),
      ...(row.session_url ? { sessionUrl: row.session_url } : {}),
      ...(row.agent_session_id ? { agentSessionId: row.agent_session_id } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.failure_code ? { failureCode: row.failure_code as DispatchFailureCode } : {}),
      ...(row.failure_stage ? { failureStage: row.failure_stage as DispatchFailureStage } : {}),
      ...(row.diagnostic_snapshot_json
        ? { diagnosticSnapshot: JSON.parse(row.diagnostic_snapshot_json) as DispatchDiagnosticSnapshot }
        : {}),
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    };
  }
}
