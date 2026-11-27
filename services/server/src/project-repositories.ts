import { projectRepositoryIdentity } from "@missiongo/domain";
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

function dispatchRepositoryMappings(db: MissionGoDatabase, dispatchId: string): Set<string> | undefined {
  const row = db.connection.prepare("SELECT repository_scope_json AS scope FROM dispatches WHERE id=?").get(dispatchId) as { scope: string | null } | undefined;
  if (!row?.scope) return undefined;
  return new Set((JSON.parse(row.scope) as { repository: string; repoPath?: string }[])
    .filter(candidate => candidate.repoPath).map(candidate => candidate.repository));
}

function repositoriesInPlan(mapped: Set<string>, plan: string): string[] {
  const lines = plan.split("\n").filter(line => line.startsWith("实施仓库："));
  const expected = lines.length === 1 ? lines[0]!.slice("实施仓库：".length).split(",").map(value => projectRepositoryIdentity(value) ?? "") : [];
  if (!expected.length || expected.some(value => !mapped.has(value))) {
    throw invalidInput("List the mapped implementation repositories in the plan summary using 实施仓库： and comma-separated repository URLs.");
  }
  return [...new Set(expected)].sort();
}

export function plannedRepositories(db: MissionGoDatabase, dispatchId: string, plan: string): string[] | undefined {
  const mapped = dispatchRepositoryMappings(db, dispatchId);
  return mapped ? repositoriesInPlan(mapped, plan) : undefined;
}

export function approvedDispatchRepositories(
  db: MissionGoDatabase, dispatchId: string, accountId: string, itemKey: string,
): string[] | undefined {
  const proposal = new ImplementationPlans(db).proposal(accountId, `dispatch:${dispatchId}`);
  if (!proposal?.valid || !proposal.approved || !proposal.keys.includes(itemKey)) return undefined;
  return plannedRepositories(db, dispatchId, proposal.plan);
}

export function scopedRepositoryApproval(
  db: MissionGoDatabase, dispatchId: string, accountId: string | undefined, itemKey: string, repository: string | undefined,
): string[] | undefined {
  const mapped = dispatchRepositoryMappings(db, dispatchId);
  if (!mapped) return undefined;
  const proposal = accountId ? new ImplementationPlans(db).proposal(accountId, `dispatch:${dispatchId}`) : undefined;
  if (!proposal?.valid || !proposal.approved || !proposal.keys.includes(itemKey)) {
    throw conflict("repository_outside_approved_scope", "The repository must belong to the approved implementation scope.");
  }
  const expected = repositoriesInPlan(mapped, proposal.plan);
  if (!repository || !expected.includes(projectRepositoryIdentity(repository) ?? "")) {
    throw conflict("repository_outside_approved_scope", "The repository must belong to the approved implementation scope.");
  }
  return expected;
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
