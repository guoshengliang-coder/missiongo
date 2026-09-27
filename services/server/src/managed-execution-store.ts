import { createHash, randomUUID } from "node:crypto";
import type { ExecutionRequest, ExecutionObservation, ExecutionIntent, ExecutionObservationReceipt } from "@missiongo/domain";
import { AgentSessionStore } from "./agent-session-store.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import { ManagedDecisionStore, type DecisionAccess } from "./managed-decision-store.js";
import { ManagedRunStore } from "./managed-run-store.js";
import type { MissionGoDatabase } from "./storage/database.js";

export type { ExecutionRequest, ExecutionObservation, ExecutionIntent } from "@missiongo/domain";
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, part: unknown) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)).digest("hex");
}
export class ManagedExecutionStore {
  constructor(private readonly db: MissionGoDatabase, private readonly enabled = false) {}
  registerExecutor(access: DecisionAccess, nodeId: string, input: { mode: string; evidence: string }): unknown {
    if (input.mode !== "single_node_local") throw conflict("unsupported_executor", "Shared workspaces across Nodes are unsupported.");
    if (!input.evidence.trim() || input.evidence.length > 1000) throw invalidInput("Local executor verification evidence is required.");
    return this.db.transaction(() => {
      const node = this.db.connection.prepare("SELECT account_id,installation_id FROM nodes WHERE id=? AND revoked_at IS NULL")
        .get(nodeId) as { account_id: string; installation_id: string } | undefined;
      const repos = this.db.connection.prepare("SELECT product_id FROM node_product_repos WHERE node_id=?").all(nodeId) as { product_id: string }[];
      if (!node || !repos.length || repos.some((r) => access(r.product_id) !== node.account_id)) throw notFound("Executor node");
      const old = this.db.connection.prepare("SELECT node_id,account_id,evidence FROM managed_executor_registrations WHERE installation_id=?")
        .get(node.installation_id) as { node_id: string; account_id: string; evidence: string } | undefined;
      if (old && (old.node_id !== nodeId || old.account_id !== node.account_id || old.evidence !== input.evidence)) {
        throw conflict("executor_registration_conflict", "Installation already has an immutable executor registration.");
      }
      if (!old) this.db.connection.prepare("INSERT INTO managed_executor_registrations VALUES (?,?,?,?,?,?)")
        .run(nodeId, node.account_id, node.installation_id, input.mode, input.evidence, new Date().toISOString());
      return { nodeId, mode: input.mode, evidence: input.evidence };
    });
  }
  request(access: DecisionAccess, input: ExecutionRequest): ExecutionIntent {
    if (!this.enabled) throw conflict("managed_execution_disabled", "Managed execution is disabled.");
    if (input.permissionMode !== (input.role === "review" ? "read-only" : "workspace-write")) throw invalidInput("Invalid role permission mode.");
    return this.db.transaction(() => {
      const decisions = new ManagedDecisionStore(this.db);
      const d = decisions.get(access, input.decisionId);
      const actor = { accountId: access(d.scope.productId), productIds: [d.scope.productId] };
      const mapping = this.db.connection.prepare(`SELECT r.id,r.repo_path FROM node_product_repos r JOIN nodes n ON n.id=r.node_id
        WHERE r.id=? AND r.product_id=? AND n.id=? AND n.account_id=? AND n.revoked_at IS NULL`)
        .get(d.scope.repositoryRef, d.scope.productId, input.nodeId, actor.accountId) as { id: string; repo_path: string } | undefined;
      if (!mapping) throw notFound("Registered repository");
      if (!this.db.connection.prepare("SELECT node_id FROM managed_executor_registrations WHERE node_id=? AND account_id=?")
        .get(input.nodeId, actor.accountId)) throw conflict("executor_not_registered", "Register a verified local executor first; each managed execution requires a dedicated worktree.");
      const old = this.db.connection.prepare("SELECT id,payload_digest FROM managed_execution_intents WHERE run_id=? AND idempotency_key=?")
        .get(input.runId, input.idempotencyKey) as { id: string; payload_digest: string } | undefined;
      if (old) {
        if (old.payload_digest !== digest(input)) throw conflict("idempotency_conflict", "Start payload differs.");
        return this.get(access, old.id);
      }
      decisions.requireApproval(access, input.decisionId, { ...input, action: input.role });
      // An uncertain execution fences its own batch, never the Node or Git common directory.
      if (this.db.connection.prepare("SELECT id FROM managed_execution_intents WHERE run_id=? AND ownership_held=1").get(input.runId)) {
        throw conflict("workspace_owned", "An unresolved execution still owns this managed run.");
      }
      const runs = new ManagedRunStore(this.db);
      const run = runs.getRun(actor, input.runId);
      const previousStage = this.db.connection.prepare("SELECT id FROM managed_stages WHERE run_id=? AND stage_key=?")
        .get(run.id, input.stageKey) as { id: string } | undefined;
      const stage = previousStage ? runs.getStage(actor, run.id, previousStage.id) : runs.createStage(actor, { runId: run.id, expectedVersion: run.version, scopeDigest: run.scopeDigest,
        contractRevision: run.scope.contractRevision, idempotencyKey: input.idempotencyKey, stageKey: input.stageKey,
        role: input.role, inputCommit: input.inputCommit });
      if (previousStage && (!["ready", "failed"].includes(stage.status) || stage.role !== input.role || stage.inputCommit !== input.inputCommit)) {
        throw conflict("stage_not_retryable", "Only a ready or reconciled failed stage with unchanged input can retry.");
      }
      const allocation = this.db.connection.prepare("SELECT COALESCE(MAX(generation),0)+1 AS generation FROM managed_execution_intents WHERE stage_id=?")
        .get(stage.id) as { generation: number };
      const result: ExecutionIntent = { id: randomUUID(), binding: input, stageId: stage.id, generation: allocation.generation,
        state: "requested", ownershipHeld: true, attemptId: null, attemptGeneration: null, sessionId: null, stopRequested: false, outcome: null, cleanup: null, updatedAt: new Date().toISOString() };
      this.db.connection.prepare(`INSERT INTO managed_execution_intents
        (id,run_id,stage_id,node_id,generation,idempotency_key,payload_digest,ownership_held,snapshot_json) VALUES (?,?,?,?,?,?,?,1,?)`)
        .run(result.id, run.id, stage.id, input.nodeId, result.generation, input.idempotencyKey, digest(input), JSON.stringify(result));
      this.db.connection.prepare("INSERT INTO managed_execution_bindings VALUES (?,?,?,?,?,?)")
        .run(result.id, mapping.id, d.scope.productId, actor.accountId, input.nodeId, mapping.repo_path);
      this.event(result, "request");
      return result;
    });
  }
  get(access: DecisionAccess, id: string): ExecutionIntent {
    return this.db.transaction(() => {
      const intent = this.read(id);
      const decision = new ManagedDecisionStore(this.db).get(access, intent.binding.decisionId);
      if (["starting", "bound", "turn_starting", "running", "waiting"].includes(intent.state) && Date.now() - Date.parse(intent.updatedAt) > 120_000) {
        intent.state = "unknown";
        if (intent.attemptId) {
          const actor = { accountId: access(decision.scope.productId), productIds: [decision.scope.productId] };
          const runs = new ManagedRunStore(this.db);
          const attempt = runs.getAttempt(actor, decision.runId, intent.stageId, intent.attemptId);
          if (attempt.status !== "unknown") runs.recordAttemptState(actor, {
            runId: decision.runId, expectedVersion: runs.getRun(actor, decision.runId).version,
            scopeDigest: decision.scopeDigest, contractRevision: decision.scope.contractRevision,
            idempotencyKey: intent.id + ":observation_timeout", stageId: intent.stageId, attemptId: attempt.id,
            generation: intent.attemptGeneration!, inputCommit: intent.binding.inputCommit, status: "unknown",
            result: { summary: "Node observation timed out; ownership retained.", evidenceRefs: ["execution:" + intent.id] },
          });
        }
        this.save(intent, "observation_timeout");
      }
      return intent;
    });
  }
  manualSnapshot(access: DecisionAccess, id: string): unknown {
    const row = this.db.connection.prepare("SELECT id,account_id,execution_generation AS generation,delivered_at AS deliveredAt FROM dispatches WHERE id=?")
      .get(id) as { id: string; account_id: string; generation: number; deliveredAt: string | null } | undefined;
    const items = this.db.connection.prepare("SELECT w.product_id FROM dispatch_items i JOIN work_items w ON w.id=i.item_id WHERE i.dispatch_id=?")
      .all(id) as { product_id: string }[];
    if (!row || !items.length || items.some((item) => access(item.product_id) !== row.account_id)
      || this.db.connection.prepare("SELECT id FROM managed_execution_intents WHERE id=?").get(id)) throw notFound("Manual dispatch");
    return { dispatchId: id, generation: row.generation, deliveredAt: row.deliveredAt,
      reconciliations: this.db.connection.prepare("SELECT generation,delivered_at AS deliveredAt,evidence,created_at AS createdAt FROM managed_manual_reconciliations WHERE dispatch_id=? ORDER BY generation").all(id) };
  }
  reconcileManual(access: DecisionAccess, id: string, input: { generation: number; deliveredAt: string; evidence: string }): unknown {
    if (!input.evidence?.trim() || input.evidence.length > 1000 || !input.deliveredAt?.trim() || input.deliveredAt.length > 100) throw invalidInput("Manual reconciliation evidence and exact delivery are required.");
    return this.db.transaction(() => {
      const row = this.db.connection.prepare("SELECT account_id,delivered_at,status,execution_generation FROM dispatches WHERE id=?")
        .get(id) as { account_id: string; delivered_at: string | null; status: string; execution_generation: number } | undefined;
      const items = this.db.connection.prepare("SELECT w.product_id FROM dispatch_items i JOIN work_items w ON w.id=i.item_id WHERE i.dispatch_id=?")
        .all(id) as { product_id: string }[];
      if (!row || !items.length || items.some((item) => access(item.product_id) !== row.account_id)) throw notFound("Manual dispatch");
      if (this.db.connection.prepare("SELECT id FROM managed_execution_intents WHERE id=?").get(id)
        || row.execution_generation !== input.generation || row.status === "queued" || row.delivered_at !== input.deliveredAt) throw conflict("manual_delivery_changed", "Only the exact observed manual delivery can be reconciled; cancel queued work first.");
      if (this.db.connection.prepare(`SELECT s.id FROM agent_sessions s WHERE s.dispatch_id=? AND (
        s.source_restore_pending=1 OR s.settings_revision>MAX(s.applied_settings_revision,s.settings_error_revision)
        OR EXISTS (SELECT 1 FROM agent_session_commands c WHERE c.session_id=s.id AND c.status IN ('queued','delivering','delivery_unknown')))`)
        .get(id)) throw conflict("manual_control_pending", "Resolve all pending manual session controls before attesting it stopped.");
      const previous = this.db.connection.prepare("SELECT delivered_at,evidence FROM managed_manual_reconciliations WHERE dispatch_id=? AND generation=?")
        .get(id, input.generation) as { delivered_at: string; evidence: string } | undefined;
      if (previous && (previous.delivered_at !== input.deliveredAt || previous.evidence !== input.evidence)) throw conflict("idempotency_conflict", "Manual reconciliation already recorded.");
      if (!previous) this.db.connection.prepare("INSERT INTO managed_manual_reconciliations VALUES (?,?,?,?,?,?)")
        .run(id, input.generation, row.account_id, input.deliveredAt, input.evidence, new Date().toISOString());
      return { dispatchId: id, generation: input.generation, deliveredAt: input.deliveredAt, evidence: input.evidence, reconciled: true };
    });
  }
  claim(access: DecisionAccess, nodeId: string, id: string, generation: number): ExecutionIntent {
    return this.db.transaction(() => {
      const intent = this.forNode(access, nodeId, id, generation);
      this.approved(access, intent);
      if (intent.state === "requested") { intent.state = "acknowledged"; this.save(intent, "acknowledge"); }
      return intent;
    });
  }
  permit(access: DecisionAccess, nodeId: string, id: string, generation: number): { intent: ExecutionIntent; mayStart: boolean } {
    return this.db.transaction(() => {
      const intent = this.forNode(access, nodeId, id, generation);
      this.approved(access, intent);
      if (intent.state !== "acknowledged" && intent.state !== "bound") return { intent, mayStart: false };
      intent.state = intent.state === "bound" ? "turn_starting" : "starting";
      this.save(intent, "permission_to_start");
      return { intent, mayStart: true };
    });
  }
  report(access: DecisionAccess, nodeId: string, id: string, report: ExecutionObservation): ExecutionIntent {
    if (!Number.isSafeInteger(report.sequence) || report.sequence <= 0) throw invalidInput("Invalid observation sequence.");
    if (!["bound", "running", "waiting", "unknown"].includes(report.state)) throw invalidInput("Invalid execution observation.");
    for (const value of [report.sessionRef, report.resolvedModel]) {
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 200)) throw invalidInput("Invalid runtime receipt.");
    }
    return this.db.transaction(() => {
      const intent = this.forNode(access, nodeId, id, report.generation, false);
      if (intent.state === "terminal") {
        // Observation-only acknowledgement: never bind a new runtime, change the
        // result, or release ownership. Even replay needs the frozen identity.
        const session = intent.sessionId && this.db.connection.prepare("SELECT agent_session_ref FROM agent_sessions WHERE id=?")
          .get(intent.sessionId) as { agent_session_ref: string } | undefined;
        const d = new ManagedDecisionStore(this.db).get(access, intent.binding.decisionId);
        const attempt = intent.attemptId && new ManagedRunStore(this.db).getAttempt(
          { accountId: access(d.scope.productId), productIds: [d.scope.productId] }, d.runId, intent.stageId, intent.attemptId);
        if (!session || !attempt || !report.sessionRef || !report.resolvedModel
          || session.agent_session_ref !== report.sessionRef || attempt.executor.sessionRef !== report.sessionRef
          || attempt.executor.resolvedModel !== report.resolvedModel) {
          throw conflict("runtime_identity_changed", "Terminal observation needs the exact frozen native session and model.");
        }
      }
      const previous = this.db.connection.prepare("SELECT payload_digest FROM managed_execution_observations WHERE intent_id=? AND sequence=?")
        .get(id, report.sequence) as { payload_digest: string } | undefined;
      if (previous) {
        if (previous.payload_digest !== digest(report)) throw conflict("idempotency_conflict", "Observation payload changed.");
        return intent;
      }
      if (this.db.connection.prepare("SELECT 1 FROM managed_execution_observations WHERE intent_id=? AND sequence>?").get(id, report.sequence)) {
        throw conflict("observation_out_of_order", "A newer observation already committed.");
      }
      if (intent.state === "terminal") {
        this.db.connection.prepare("INSERT INTO managed_execution_observations VALUES (?,?,?,?)")
          .run(id, report.sequence, digest(report), JSON.stringify(report));
        this.event(intent, "terminal_observation_archived");
        return intent;
      }
      if (["requested", "acknowledged"].includes(intent.state)) throw conflict("observation_not_expected", "No launch is pending.");
      if (report.state === "bound" && (!["starting", "unknown"].includes(intent.state) || !report.sessionRef || !report.resolvedModel)) throw conflict("binding_not_expected", "Identity binding needs a pending launch and complete receipt.");
      const d = new ManagedDecisionStore(this.db).get(access, intent.binding.decisionId);
      const actor = { accountId: access(d.scope.productId), productIds: [d.scope.productId] };
      const runs = new ManagedRunStore(this.db);
      const command = (operation: string) => ({ runId: d.runId, expectedVersion: runs.getRun(actor, d.runId).version,
        scopeDigest: d.scopeDigest, contractRevision: d.scope.contractRevision, idempotencyKey: intent.id + ":observation:" + report.sequence + ":" + operation });
      if (intent.sessionId && report.sessionRef) {
        const session = this.db.connection.prepare("SELECT agent_session_ref FROM agent_sessions WHERE id=?").get(intent.sessionId) as { agent_session_ref: string };
        if (session.agent_session_ref !== report.sessionRef) throw conflict("runtime_identity_changed", "Native session differs.");
      }
      if (!intent.sessionId && report.sessionRef) {
        if (this.db.connection.prepare("SELECT id FROM agent_sessions WHERE node_id=? AND agent_kind='codex' AND agent_session_ref=?")
          .get(nodeId, report.sessionRef)) throw conflict("runtime_session_bound", "Native session already belongs to another delivery.");
        // A projection into the existing conversation UI, never a queued manual dispatch.
        const now = new Date().toISOString();
        const mapping = this.db.connection.prepare("SELECT repo_path FROM managed_execution_bindings WHERE intent_id=?").get(intent.id) as { repo_path: string };
        this.db.connection.prepare("INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,delivered_at,completed_at,session_name) VALUES (?,?,?,'codex','default','launched',?,?,?,?,?)")
          .run(intent.id, actor.accountId, nodeId, mapping.repo_path, now, now, now, "Managed " + intent.binding.role);
        d.scope.itemKeys.forEach((key, position) => this.db.connection.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) SELECT ?,id,? FROM work_items WHERE item_key=?")
          .run(intent.id, position, key));
        intent.sessionId = new AgentSessionStore(this.db).createForDispatch({ dispatchId: intent.id, nodeId, sessionRef: report.sessionRef });
      }
      if (intent.attemptId && report.resolvedModel) {
        const attempt = runs.getAttempt(actor, d.runId, intent.stageId, intent.attemptId);
        if (attempt.executor.resolvedModel !== report.resolvedModel) throw conflict("runtime_identity_changed", "Resolved model differs.");
      }
      if (!intent.attemptId && report.sessionRef && report.resolvedModel) {
        const attempt = runs.beginAttempt(actor, { ...command("begin"), stageId: intent.stageId, inputCommit: intent.binding.inputCommit,
          executor: { agentKind: "codex", sessionRef: report.sessionRef, resolvedModel: report.resolvedModel } });
        intent.attemptId = attempt.id;
        intent.attemptGeneration = attempt.generation;
        this.db.connection.prepare("UPDATE agent_sessions SET model=? WHERE id=?").run(report.resolvedModel, intent.sessionId!);
      }
      // Lost launch receipts remain uncertain even when a later snapshot looks idle/running.
      intent.state = !intent.attemptId || intent.state === "unknown" ? "unknown" : report.state;
      if (intent.attemptId) {
        const attempt = runs.getAttempt(actor, d.runId, intent.stageId, intent.attemptId);
        const status = intent.state === "waiting" ? "waiting_for_human" : intent.state === "bound" ? "running" : intent.state;
        if (attempt.status !== status) runs.recordAttemptState(actor, { ...command("state"), stageId: intent.stageId,
          attemptId: attempt.id, generation: intent.attemptGeneration!, inputCommit: intent.binding.inputCommit, status,
          result: { summary: "Native execution observation: " + status, evidenceRefs: ["execution:" + intent.id] } });
      }
      this.db.connection.prepare("INSERT INTO managed_execution_observations VALUES (?,?,?,?)")
        .run(id, report.sequence, digest(report), JSON.stringify(report));
      this.save(intent, "observation");
      return intent;
    });
  }
  // Only frozen bindings confer observation/stop rights; these never authorize execution.
  private observationAccess(node: { nodeId: string; accountId: string }, id: string): DecisionAccess {
    const row = this.db.connection.prepare(
      "SELECT b.product_id FROM managed_execution_bindings b JOIN nodes n ON n.id=b.node_id WHERE b.intent_id=? AND b.node_id=? AND b.account_id=? AND n.account_id=b.account_id AND n.revoked_at IS NULL"
    ).get(id, node.nodeId, node.accountId) as { product_id: string } | undefined;
    if (!row) throw notFound("Node execution");
    return (productId) => {
      if (productId !== row.product_id) throw notFound("Node execution");
      return node.accountId;
    };
  }
  stopForNode(node: { nodeId: string; accountId: string }, id: string, generation: number): void {
    this.stop(this.observationAccess(node, id), id, generation);
  }
  reportForNode(node: { nodeId: string; accountId: string }, id: string, report: ExecutionObservation, executionAccess: DecisionAccess): ExecutionObservationReceipt {
    const access = this.observationAccess(node, id);
    let executable = this.enabled;
    try { this.get(executionAccess, id); } catch (error) {
      if (!(error instanceof Error) || !("statusCode" in error) || error.statusCode !== 404) throw error;
      executable = false;
    }
    if (!executable) this.stop(access, id, report.generation);
    const intent = this.report(access, node.nodeId, id, report);
    return intent.state === "terminal"
      ? { accepted: true, terminal: { intentId: intent.id, generation: intent.generation, sequence: report.sequence,
        state: "terminal", sessionRef: report.sessionRef!, resolvedModel: report.resolvedModel! } }
      : { accepted: true };
  }
  authorizeSessionInput(access: DecisionAccess, nodeId: string, sessionId: string, commandId?: string): void {
    const binding = new AgentSessionStore(this.db).managedBinding(sessionId);
    if (!binding) throw notFound("Managed session");
    const intent = this.forNode(access, nodeId, binding.id, binding.generation, false);
    this.approved(access, intent);
    if (!["running", "waiting"].includes(intent.state)) throw conflict("input_not_ready", "The exact runtime must be known before input delivery.");
    if (commandId && !this.db.connection.prepare("SELECT 1 FROM managed_execution_inputs WHERE intent_id=? AND command_id=?").get(intent.id, commandId)) {
      throw conflict("managed_input_binding", "Input is not bound to this managed intent.");
    }
  }
  input(access: DecisionAccess, id: string, input: { generation: number; idempotencyKey: string; text: string }): unknown {
    if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 200 || !input.text?.trim() || input.text.length > 8000) throw invalidInput("Invalid supplemental input.");
    return this.db.transaction(() => {
      const intent = this.get(access, id);
      this.approved(access, intent);
      if (intent.generation !== input.generation || !intent.sessionId || !intent.attemptId || !["running", "waiting"].includes(intent.state)) throw conflict("input_not_ready", "Input needs the exact known attempt.");
      const previous = this.db.connection.prepare("SELECT command_id,payload_digest FROM managed_execution_inputs WHERE intent_id=? AND idempotency_key=?")
        .get(id, input.idempotencyKey) as { command_id: string; payload_digest: string } | undefined;
      if (previous) {
        if (previous.payload_digest !== digest(input)) throw conflict("idempotency_conflict", "Input payload differs.");
        return this.db.connection.prepare("SELECT id,status FROM agent_session_commands WHERE id=?").get(previous.command_id);
      }
      const d = new ManagedDecisionStore(this.db).get(access, intent.binding.decisionId);
      const command = new AgentSessionStore(this.db).enqueue(access(d.scope.productId), intent.sessionId, input.text, [], true);
      this.db.connection.prepare("INSERT INTO managed_execution_inputs VALUES (?,?,?,?)").run(id, input.idempotencyKey, digest(input), command.id);
      this.event(intent, "input_queued");
      return { id: command.id, status: command.status };
    });
  }
  stop(access: DecisionAccess, id: string, generation: number): ExecutionIntent {
    return this.db.transaction(() => {
      const intent = this.get(access, id);
      if (generation !== intent.generation) throw conflict("stale_generation", "Execution generation differs.");
      if (!intent.stopRequested) {
        intent.stopRequested = true;
        if (["requested", "acknowledged"].includes(intent.state)) {
          intent.state = "terminal"; intent.outcome = "cancelled"; intent.ownershipHeld = false;
        }
        this.save(intent, "stop_requested");
      }
      return intent;
    });
  }
  finish(access: DecisionAccess, id: string, input: { generation: number; outcome: "succeeded" | "failed"; summary: string; evidence: string }): ExecutionIntent {
    if (!["succeeded", "failed"].includes(input.outcome) || !input.summary?.trim() || input.summary.length > 4000
      || !input.evidence?.trim() || input.evidence.length > 1000) throw invalidInput("A bounded result and reconciliation evidence are required.");
    return this.db.transaction(() => {
      const intent = this.get(access, id);
      if (input.generation !== intent.generation) throw conflict("stale_generation", "Execution generation differs.");
      if (intent.state === "terminal") {
        if (intent.resultDigest !== digest(input)) throw conflict("terminal_result", "Terminal result differs.");
        return intent;
      }
      if (["requested", "acknowledged"].includes(intent.state)) throw conflict("not_started", "Cancel an unstarted intent instead.");
      if (input.outcome === "succeeded" && (!intent.attemptId || !intent.sessionId)) throw conflict("runtime_receipt_missing", "A real native session and model receipt are required for success.");
      const d = new ManagedDecisionStore(this.db).get(access, intent.binding.decisionId);
      const actor = { accountId: access(d.scope.productId), productIds: [d.scope.productId] };
      const runs = new ManagedRunStore(this.db);
      if (intent.attemptId) runs.recordAttemptState(actor, { runId: d.runId, expectedVersion: runs.getRun(actor, d.runId).version,
        scopeDigest: d.scopeDigest, contractRevision: d.scope.contractRevision, idempotencyKey: intent.id + ":finish",
        stageId: intent.stageId, attemptId: intent.attemptId, generation: intent.attemptGeneration!, inputCommit: intent.binding.inputCommit,
        status: input.outcome, result: { summary: input.summary, evidenceRefs: [input.evidence] }, reconciliationEvidence: input.evidence });
      intent.state = "terminal"; intent.outcome = input.outcome; intent.resultDigest = digest(input);
      intent.stopRequested = true;
      this.save(intent, "result");
      return intent;
    });
  }
  reconcileCleanup(access: DecisionAccess, id: string, generation: number, evidence: string): ExecutionIntent {
    if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 1000) throw invalidInput("Cleanup evidence required.");
    return this.db.transaction(() => {
      const intent = this.get(access, id);
      if (generation !== intent.generation || intent.state !== "terminal") throw conflict("cleanup_not_ready", "Reconcile result first.");
      if (intent.cleanup && intent.cleanup !== evidence) throw conflict("cleanup_changed", "Cleanup observation already recorded.");
      if (!intent.cleanup) { intent.cleanup = evidence; intent.ownershipHeld = false; this.save(intent, "cleanup_reconciled"); }
      return intent;
    });
  }
  private approved(access: DecisionAccess, intent: ExecutionIntent): void {
    if (!this.enabled) throw conflict("managed_execution_disabled", "Managed execution is disabled.");
    new ManagedDecisionStore(this.db).requireApproval(access, intent.binding.decisionId, { ...intent.binding, action: intent.binding.role });
    if (intent.stopRequested || intent.state === "terminal") throw conflict("execution_stopped", "Execution cannot start.");
  }
  private forNode(access: DecisionAccess, nodeId: string, id: string, generation: number, requireMapping = true): ExecutionIntent {
    const intent = this.get(access, id);
    if (intent.binding.nodeId !== nodeId) throw notFound("Node execution");
    if (intent.generation !== generation) throw conflict("stale_generation", "Execution generation differs.");
    const d = new ManagedDecisionStore(this.db).get(access, intent.binding.decisionId);
    if (!this.db.connection.prepare("SELECT b.intent_id FROM managed_execution_bindings b JOIN nodes n ON n.id=b.node_id WHERE b.intent_id=? AND b.node_id=? AND b.account_id=? AND n.account_id=b.account_id AND n.revoked_at IS NULL")
      .get(id, nodeId, access(d.scope.productId))) throw notFound("Registered node execution");
    if (requireMapping && !this.db.connection.prepare(
      "SELECT r.id FROM node_product_repos r JOIN nodes n ON n.id=r.node_id WHERE r.id=? AND r.node_id=? AND r.product_id=? AND n.account_id=? AND n.revoked_at IS NULL"
    ).get(d.scope.repositoryRef, nodeId, d.scope.productId, access(d.scope.productId))) throw notFound("Registered node mapping");
    return intent;
  }
  private save(intent: ExecutionIntent, operation: string): void {
    intent.updatedAt = new Date().toISOString();
    this.db.connection.prepare("UPDATE managed_execution_intents SET snapshot_json=?,ownership_held=? WHERE id=?")
      .run(JSON.stringify(intent), intent.ownershipHeld ? 1 : 0, intent.id);
    this.event(intent, operation);
  }
  private read(id: string): ExecutionIntent {
    const row = this.db.connection.prepare("SELECT snapshot_json FROM managed_execution_intents WHERE id=?").get(id) as { snapshot_json: string } | undefined;
    if (!row) throw notFound("Execution intent");
    return JSON.parse(row.snapshot_json) as ExecutionIntent;
  }
  private event(intent: ExecutionIntent, operation: string): void {
    this.db.connection.prepare(`INSERT INTO managed_execution_events(intent_id,sequence,operation,snapshot_json,created_at)
      SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,? FROM managed_execution_events WHERE intent_id=?`)
      .run(intent.id, operation, JSON.stringify(intent), new Date().toISOString(), intent.id);
  }
}
