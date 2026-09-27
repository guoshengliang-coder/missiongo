import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ManagedRunScope } from "@missiongo/domain";
import type { MissionGoDatabase } from "./storage/database.js";
import { ManagedExecutionStore } from "./managed-execution-store.js";
import { ManagedRunStore } from "./managed-run-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ManagedDecisionStore } from "./managed-decision-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import type { DecisionAccess } from "./managed-decision-store.js";

const text = z.string().trim().min(1).max(200);
// Runtime identities are exact evidence and part of the observation digest.
const runtimeIdentity = z.string().min(1).max(200).refine((value) => value === value.trim());
const generation = z.number().int().positive();
const requestSchema = z.object({ runId: text, decisionId: text, version: generation, stateVersion: generation,
  contentDigest: text, scopeDigest: text, contractRevision: generation, idempotencyKey: text,
  stageKey: text, role: z.enum(["implement", "review", "verify"]), inputCommit: z.string().regex(/^[a-f0-9]{40}$/),
  nodeId: text, permissionMode: z.enum(["read-only", "workspace-write"]) }).strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw invalidInput("Invalid managed execution contract.");
  return result.data;
}
export function registerManagedExecutionRoutes(app: FastifyInstance, options: {
  db: MissionGoDatabase; enabled: boolean;
  coordinator: (request: FastifyRequest, capability: "view" | "operate" | "ai") => DecisionAccess;
  node: (request: FastifyRequest) => { nodeId: string; accountId: string };
  nodeAccess: (request: FastifyRequest, launch: boolean) => DecisionAccess;
}): void {
  const { db } = options;
  const executions = new ManagedExecutionStore(db, options.enabled);
  const runs = new ManagedRunStore(db);
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  const prefix = "/api/v1/managed-execution";
  app.get(prefix + "/manual-dispatches/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return executions.manualSnapshot(options.coordinator(request, "view"), id(request));
  });
  app.post(prefix + "/executors/:id/register", async (request) => executions.registerExecutor(options.coordinator(request, "operate"), id(request),
    parse(z.object({ mode: z.literal("single_node_local"), evidence: z.string().min(1).max(1000) }).strict(), request.body)));
  app.post(`${prefix}/manual-dispatches/:id/reconcile`, async (request) => executions.reconcileManual(options.coordinator(request, "operate"), id(request),
    parse(z.object({ generation, deliveredAt: z.string().min(1).max(100), evidence: z.string().min(1).max(1000) }).strict(), request.body)));
  app.get(`${prefix}/repositories`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const access = options.coordinator(request, "view");
    const rows = db.connection.prepare("SELECT r.id AS repositoryRef,r.product_id AS productId,r.node_id AS nodeId,n.account_id AS accountId FROM node_product_repos r JOIN nodes n ON n.id=r.node_id WHERE n.revoked_at IS NULL").all() as { repositoryRef: string; productId: string; nodeId: string; accountId: string }[];
    return { repositories: rows.filter((row) => { try { return access(row.productId) === row.accountId; } catch { return false; } })
      .map(({ repositoryRef, productId, nodeId }) => ({ repositoryRef, productId, nodeId })) };
  });
  app.post(`${prefix}/runs`, async (request) => {
    const b = parse(z.object({ scope: z.object({ productId: text, repositoryRef: text, itemKeys: z.array(text).min(1).max(20), contractRevision: generation }).strict(), idempotencyKey: text }).strict(), request.body);
    const access = options.coordinator(request, "ai");
    if (!options.enabled) throw conflict("managed_execution_disabled", "Managed execution is disabled.");
    return db.transaction(() => {
      const accountId = access(b.scope.productId);
      if (!db.connection.prepare("SELECT r.id FROM node_product_repos r JOIN nodes n ON n.id=r.node_id WHERE r.id=? AND r.product_id=? AND n.account_id=? AND n.revoked_at IS NULL")
        .get(b.scope.repositoryRef, b.scope.productId, accountId)) throw notFound("Repository mapping");
      return runs.createRun({ accountId, productIds: [b.scope.productId] }, { ...b, scope: b.scope as ManagedRunScope });
    });
  });
  app.get(`${prefix}/runs/:id`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const row = db.connection.prepare("SELECT product_id FROM managed_runs WHERE id=?").get(id(request)) as { product_id: string } | undefined;
    if (!row) throw notFound("Managed run");
    const access = options.coordinator(request, "view");
    const run = runs.getRun({ accountId: access(row.product_id), productIds: [row.product_id] }, id(request));
    const intents = db.connection.prepare("SELECT id FROM managed_execution_intents WHERE run_id=? ORDER BY rowid").all(run.id) as { id: string }[];
    return { run, intents: intents.map((i) => executions.get(access, i.id)) };
  });
  app.post(`${prefix}/intents`, async (request) => executions.request(options.coordinator(request, "ai"), parse(requestSchema, request.body)));
  app.get(`${prefix}/intents/:id`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return executions.get(options.coordinator(request, "view"), id(request));
  });
  app.get(`${prefix}/intents/:id/events`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    executions.get(options.coordinator(request, "view"), id(request));
    const after = Number((request.query as { after?: string }).after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw invalidInput("Invalid cursor.");
    const events = db.connection.prepare("SELECT sequence,operation,snapshot_json,created_at AS createdAt FROM managed_execution_events WHERE intent_id=? AND sequence>? ORDER BY sequence LIMIT 100").all(id(request), after);
    return { events: events.map(({ snapshot_json, ...rest }) => ({ ...rest, intent: JSON.parse(snapshot_json as string) })) };
  });
  app.get(`${prefix}/intents/:id/session`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const access = options.coordinator(request, "view");
    const intent = executions.get(access, id(request));
    const decision = new ManagedDecisionStore(db).get(access, intent.binding.decisionId);
    const actor = { accountId: access(decision.scope.productId), productIds: [decision.scope.productId] };
    return {
      session: intent.sessionId ? new AgentSessionStore(db).getForAccount(actor.accountId, intent.sessionId) : null,
      attempt: intent.attemptId ? runs.getAttempt(actor, decision.runId, intent.stageId, intent.attemptId) : null,
    };
  });
  app.post(`${prefix}/intents/:id/stop`, async (request) => {
    const b = parse(z.object({ generation }).strict(), request.body);
    return executions.stop(options.coordinator(request, "operate"), id(request), b.generation);
  });
  app.post(`${prefix}/intents/:id/input`, async (request) => executions.input(options.coordinator(request, "ai"), id(request),
    parse(z.object({ generation, idempotencyKey: text, text: z.string().min(1).max(8000) }).strict(), request.body)));
  app.post(`${prefix}/intents/:id/finish`, async (request) => executions.finish(options.coordinator(request, "operate"), id(request),
    parse(z.object({ generation, outcome: z.enum(["succeeded", "failed"]), summary: z.string().min(1).max(4000), evidence: z.string().min(1).max(1000) }).strict(), request.body)));
  app.post(`${prefix}/intents/:id/cleanup`, async (request) => {
    const b = parse(z.object({ generation, evidence: z.string().min(1).max(1000) }).strict(), request.body);
    return executions.reconcileCleanup(options.coordinator(request, "operate"), id(request), b.generation, b.evidence);
  });
  app.get("/api/v1/node/managed-execution", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const node = options.node(request);
    const access = options.nodeAccess(request, false);
    const rows = db.connection.prepare("SELECT i.id,i.generation,b.product_id FROM managed_execution_intents i JOIN managed_execution_bindings b ON b.intent_id=i.id WHERE i.node_id=? AND b.node_id=? AND b.account_id=? AND i.ownership_held=1 ORDER BY i.rowid")
      .all(node.nodeId, node.nodeId, node.accountId) as { id: string; generation: number; product_id: string }[];
    const jobs = [];
    const stops = [];
    for (const row of rows) {
      let executable = options.enabled;
      try { options.nodeAccess(request, true)(row.product_id); }
      catch (error) {
        if (!(error instanceof Error) || !("statusCode" in error) || error.statusCode !== 404) throw error;
        executable = false;
      }
      if (!executable) {
        executions.stopForNode(node, row.id, row.generation);
        stops.push({ id: row.id, generation: row.generation });
        continue;
      }
      const intent = executions.get(access, row.id);
      const d = db.connection.prepare("SELECT snapshot_json FROM decision_records WHERE id=?").get(intent.binding.decisionId) as { snapshot_json: string };
      const decision = JSON.parse(d.snapshot_json);
      const mapping = db.connection.prepare("SELECT repo_path FROM managed_execution_bindings WHERE intent_id=? AND node_id=? AND account_id=?").get(intent.id, node.nodeId, node.accountId) as { repo_path: string } | undefined;
      if (!mapping) throw notFound("Repository mapping");
      const items = decision.scope.itemKeys.map((key: string) => db.connection.prepare("SELECT item_key AS key,title,substr(description,1,2000) AS description FROM work_items WHERE item_key=?").get(key));
      jobs.push({ intent, repoPath: mapping.repo_path, taskContext: JSON.stringify({ decision: decision.content, items }), enabled: options.enabled });
    }
    return { jobs, stops };
  });
  for (const operation of ["claim", "permit"] as const) app.post(`/api/v1/node/managed-execution/:id/${operation}`, async (request) => {
    const b = parse(z.object({ generation }).strict(), request.body);
    return executions[operation](options.nodeAccess(request, true), options.node(request).nodeId, id(request), b.generation);
  });
  app.post("/api/v1/node/managed-execution/:id/report", async (request) => {
    const b = parse(z.object({ sequence: generation, generation, state: z.enum(["bound", "running", "waiting", "unknown"]), sessionRef: runtimeIdentity.optional(), resolvedModel: runtimeIdentity.optional() }).strict(), request.body);
    const node = options.node(request);
    return executions.reportForNode(node, id(request), b, options.nodeAccess(request, true));
  });
}
