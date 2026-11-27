import { sessionHealth } from "./agent-session-health.js";
import type { AgentSessionStatus } from "./agent-session-store.js";
import { deliveryRound } from "./delivery-round.js";
import { nodeConnectionState, projectRepositoryIdentity } from "@missiongo/domain";
import { ImplementationPlans } from "./implementation-plans.js";
import type { MissionGoDatabase } from "./storage/database.js";

import { randomUUID } from "node:crypto";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { MissionGoStore } from "./store.js";

export interface ProjectRepository {
  id: string;
  name: string;
  repository: string;
  responsibility: string;
}

export class ProjectRepositories {
  constructor(private readonly store: MissionGoStore) {}

  list(productId: string): ProjectRepository[] {
    return this.store.database.connection.prepare(`
      SELECT id, name, repository, responsibility FROM project_repositories
      WHERE product_id=? AND archived_at IS NULL ORDER BY name, id
    `).all(productId) as unknown as ProjectRepository[];
  }

  save(productId: string, input: Omit<ProjectRepository, "id">, id?: string): ProjectRepository {
    this.store.assertProductWritable(productId);
    const name = input.name.trim();
    const responsibility = input.responsibility.trim();
    const repository = projectRepositoryIdentity(input.repository);
    if (!repository || !input.repository.trim().startsWith("https://")
        || input.repository.length > 500 || !name || name.length > 100 || responsibility.length > 500) {
      throw invalidInput("Provide a repository HTTPS URL without credentials, a name and an optional responsibility.");
    }
    return this.store.database.transaction(() => {
      const db = this.store.database.connection;
      const existing = db.prepare("SELECT id,repository FROM project_repositories WHERE product_id=? AND id=? AND archived_at IS NULL")
        .get(productId, id ?? "") as { id: string; repository: string } | undefined;
      if (id && !existing) throw notFound("Project repository");
      if (existing && existing.repository !== repository) throw conflict("repository_identity_changed", "Archive this repository and add the new remote separately.");
      const row = db.prepare("SELECT id,archived_at FROM project_repositories WHERE product_id=? AND repository=?")
        .get(productId, repository) as { id: string; archived_at: string | null } | undefined;
      if (!id && row && !row.archived_at) throw conflict("duplicate_repository", "This repository is already registered.");
      const repositoryId = id ?? row?.id ?? randomUUID();
      if (id || row) db.prepare("UPDATE project_repositories SET name=?,responsibility=?,archived_at=NULL WHERE id=?").run(name, responsibility, repositoryId);
      else db.prepare("INSERT INTO project_repositories(id,product_id,name,repository,responsibility) VALUES (?,?,?,?,?)")
        .run(repositoryId, productId, name, repository, responsibility);
      return { id: repositoryId, repository, name, responsibility };
    });
  }

  archive(productId: string, repositoryId: string): void {
    this.store.assertProductWritable(productId);
    const result = this.store.database.connection.prepare(
      "UPDATE project_repositories SET archived_at=? WHERE product_id=? AND id=? AND archived_at IS NULL",
    ).run(new Date().toISOString(), productId, repositoryId);
    if (!result.changes) throw notFound("Project repository");
  }
}

export function nativeRepositoryPlanIdentity(clientId: string, agentKind: string, refKind: string, sessionRef: string): string {
  return `native:${clientId}:${agentKind}:${refKind}:${sessionRef}`;
}

export interface RepositoryCandidate extends ProjectRepository {
  repoPath?: string;
}

export function captureExternalRepositoryScope(store: MissionGoStore, sessionId: string, itemKey: string): void {
  const item = store.getWorkItem(itemKey);
  const round = deliveryRound(store.database, item.id, true);
  if (!round) return;
  const session = store.database.connection.prepare(
    "SELECT account_id,client_id,agent_kind,ref_kind,session_ref FROM external_agent_sessions WHERE id=?",
  ).get(sessionId) as { account_id: string; client_id: string; agent_kind: string; ref_kind: string; session_ref: string } | undefined;
  if (!session || session.ref_kind !== "native" || !["codex", "claude_code", "opencode"].includes(session.agent_kind)) return;
  const identity = nativeRepositoryPlanIdentity(session.client_id, session.agent_kind, session.ref_kind, session.session_ref);
  const approved = new ImplementationPlans(store.database).proposal(session.account_id, identity);
  if (approved?.valid && approved.approved && approved.keys.includes(itemKey)
      && !approved.plan.split("\n").some(line => line.startsWith("实施仓库：") || line.startsWith(`实施仓库 ${itemKey}：`))) return;
  const repositories = new ProjectRepositories(store).list(item.productId);
  if (!repositories.length) return;
  store.database.connection.prepare(`INSERT OR IGNORE INTO external_repository_scopes(session_id,item_id,round_key,repositories_json)
    VALUES (?,?,?,?)`).run(sessionId, item.id, round, JSON.stringify(repositories));
}

function readRepositoryScope(db: MissionGoDatabase, source: string, itemKey: string) {
  const [type, id] = source.split(":", 2);
  if (type === "dispatch" && id) {
    const row = db.connection.prepare("SELECT repository_scope_json AS scope,node_id FROM dispatches WHERE id=?")
      .get(id) as { scope: string | null; node_id: string } | undefined;
    if (!row?.scope) return;
    return { candidates: JSON.parse(row.scope) as RepositoryCandidate[], identity: source, isDispatch: true, node: row.node_id };
  }
  if (type !== "session" || !id) return;
  const item = db.connection.prepare("SELECT id FROM work_items WHERE item_key=?").get(itemKey) as { id: string } | undefined;
  if (!item) return;
  const row = db.connection.prepare(`
    SELECT r.repositories_json AS scope,s.agent_kind,s.ref_kind,s.session_ref,s.client_id,n.id AS node,n.last_seen_at,s.native_snapshot_json
    FROM external_repository_scopes r JOIN external_agent_sessions s ON s.id=r.session_id
    LEFT JOIN nodes n ON n.id=s.native_node_id AND n.account_id=s.account_id AND n.revoked_at IS NULL
      AND s.native_synced_at IS NOT NULL AND s.native_snapshot_json IS NOT NULL AND s.archived_at IS NULL
      AND (s.agent_kind <> 'opencode' OR EXISTS (
        SELECT 1 FROM json_each(n.agents_json) a WHERE json_extract(a.value,'$.kind')='opencode'
          AND json_extract(a.value,'$.repositoryScopeProtocol')=1
      ))
    WHERE r.session_id=? AND r.item_id=? AND r.round_key=?
  `).get(id, item.id, deliveryRound(db, item.id, true)) as {
    scope: string; agent_kind: string; ref_kind: string; session_ref: string; client_id: string; node: string | null; last_seen_at: string | null; native_snapshot_json: string | null;
  } | undefined;
  if (!row) return;
  const snapshot = row.native_snapshot_json ? JSON.parse(row.native_snapshot_json) as { status: AgentSessionStatus; sourceArchived?: boolean } : undefined;
  const verified = row.node && snapshot && !snapshot.sourceArchived
    && !["failed", "unavailable", "suspended"].includes(sessionHealth(snapshot.status, {}).status)
    && nodeConnectionState(row.last_seen_at ?? undefined) === "online";
  return {
    candidates: JSON.parse(row.scope) as RepositoryCandidate[],
    identity: nativeRepositoryPlanIdentity(row.client_id, row.agent_kind, row.ref_kind, row.session_ref),
    isDispatch: false,
    node: verified ? row.node : null,
  };
}

export function repositoryCandidates(
  db: MissionGoDatabase, source: string, itemKey: string, includePaths = false,
): RepositoryCandidate[] | undefined {
  const scope = readRepositoryScope(db, source, itemKey);
  if (!scope) return;
  const paths = includePaths && !scope.isDispatch && scope.node ? db.connection.prepare(
    "SELECT repo_path FROM node_repository_paths WHERE node_id=? AND repository_id=?",
  ) : undefined;
  return scope.candidates.map(({ repoPath, ...candidate }) => {
    const local = paths ? (paths.get(scope.node!, candidate.id) as { repo_path: string } | undefined)?.repo_path : undefined;
    const path = includePaths ? local ?? repoPath : undefined;
    return { ...candidate, ...(path ? { repoPath: path } : {}) };
  });
}

function repositoriesInPlan(scope: NonNullable<ReturnType<typeof readRepositoryScope>>, itemKey: string, plan: string): string[] {
  const candidates = new Set(scope.candidates.filter(candidate => !scope.isDispatch || candidate.repoPath)
    .map(candidate => candidate.repository));
  const prefix = `实施仓库 ${itemKey}：`;
  const lines = plan.split("\n");
  const itemLines = lines.filter(line => line.startsWith(prefix));
  const sharedLines = lines.filter(line => line.startsWith("实施仓库："));
  const line = itemLines.length === 1 && !sharedLines.length ? itemLines[0]
    : sharedLines.length === 1 && !lines.some(value => /^实施仓库 [A-Z0-9-]+：/.test(value)) ? sharedLines[0] : undefined;
  const expected = line ? line.slice(line.indexOf("：") + 1).split(",").map(value => projectRepositoryIdentity(value) ?? "") : [];
  if (!expected.length || expected.some(value => !candidates.has(value))) {
    throw invalidInput("List the implementation repositories in the plan summary using 实施仓库： or one 实施仓库 ITEM-1： line per item, followed by comma-separated registered repository URLs.");
  }
  return [...new Set(expected)].sort();
}

export function plannedRepositories(db: MissionGoDatabase, source: string, itemKey: string, plan: string): string[] | undefined {
  const scope = readRepositoryScope(db, source, itemKey);
  return scope ? repositoriesInPlan(scope, itemKey, plan) : undefined;
}

export function approvedSessionRepositories(
  db: MissionGoDatabase, source: string, accountId: string, itemKey: string, keepPriorApproval = false,
): string[] | undefined {
  const scope = readRepositoryScope(db, source, itemKey);
  if (!scope) return;
  const plans = new ImplementationPlans(db);
  const proposal = plans.proposal(accountId, scope.identity);
  if (proposal?.valid && proposal.approved && proposal.keys.includes(itemKey)) return repositoriesInPlan(scope, itemKey, proposal.plan);
  if (!keepPriorApproval || !proposal || proposal.approved) return;
  // An unapproved revision cannot remove the original commitment from an item's aggregate.
  const prior = db.connection.prepare(`SELECT plan_text,scope_json FROM implementation_plan_approvals
    WHERE account_id=? AND identity_key=?
    ORDER BY approved_at DESC,rowid DESC LIMIT 1`).get(accountId, scope.identity) as
    { plan_text: string | null; scope_json: string } | undefined;
  if (!prior?.plan_text) return;
  const keys = (JSON.parse(prior.scope_json) as { key: string }[]).map(entry => entry.key);
  if (!keys.includes(itemKey) || plans.scope(keys) !== prior.scope_json) return;
  return repositoriesInPlan(scope, itemKey, prior.plan_text);
}

export function scopedRepositoryApproval(
  db: MissionGoDatabase, source: string, accountId: string | undefined, itemKey: string, repository: string | undefined,
): string[] | undefined {
  const scope = readRepositoryScope(db, source, itemKey);
  if (!scope) return;
  const expected = accountId ? approvedSessionRepositories(db, source, accountId, itemKey) : undefined;
  if (!expected || !repository || !expected.includes(projectRepositoryIdentity(repository) ?? "")) {
    throw conflict("repository_outside_approved_scope", "The repository must belong to the approved implementation scope.");
  }
  return expected;
}

export function activeRepositoryClaims(db: MissionGoDatabase, itemId: string) {
  return db.connection.prepare(`
    SELECT DISTINCT a.account_id AS accountId, CASE WHEN a.dispatch_id IS NOT NULL THEN 'dispatch:' || a.dispatch_id
      ELSE 'session:' || json_extract(r.result_json,'$.sessionId') END AS source
    FROM builder_execution_authorizations a
    LEFT JOIN mcp_agent_claim_receipts r ON a.dispatch_id IS NULL AND r.account_id=a.account_id AND r.client_id=a.client_id
      AND EXISTS (SELECT 1 FROM external_repository_scopes s WHERE s.item_id=a.item_id AND s.round_key=a.round_key)
      AND json_extract(r.result_json,'$.executionAuthorization')=a.id AND json_extract(r.result_json,'$.item.id')=a.item_id
    WHERE a.item_id=? AND a.round_key=? AND a.revoked=0
  `).all(itemId, deliveryRound(db, itemId, true)) as unknown as { accountId: string; source: string | null }[];
}

export function registeredRepository(db: MissionGoDatabase, productId: string, repository: string): boolean {
  return Boolean(db.connection.prepare(
    "SELECT 1 FROM project_repositories WHERE product_id=? AND repository=?",
  ).get(productId, projectRepositoryIdentity(repository) ?? ""));
}

export function completionRepository(completion: { kind: string; url?: string } | undefined): string | undefined {
  if (completion?.kind === "github") return completion.url ? projectRepositoryIdentity(completion.url.replace(/\/pull\/\d+$/, "")) : undefined;
  if (completion?.kind === "gitlab") return completion.url ? projectRepositoryIdentity(completion.url.replace(/\/-\/merge_requests\/\d+$/, "")) : undefined;
}
