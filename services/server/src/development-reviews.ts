import { createHash } from "node:crypto";
import { z } from "zod";
import type { DevelopmentReviewEvidence } from "@missiongo/domain";
import type { MissionGoDatabase } from "./storage/database.js";
import { conflict, invalidInput } from "./errors.js";

export const DEVELOPMENT_REVIEW_SCHEMA = `
CREATE TABLE development_reviews (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id TEXT NOT NULL,
  task_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
  digest TEXT NOT NULL, payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  UNIQUE(session_id,task_id,revision)
) STRICT;
CREATE TABLE development_review_policy(session_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, required INTEGER NOT NULL CHECK(required=1), unavailable INTEGER NOT NULL DEFAULT 0, active_task_id TEXT) STRICT;
CREATE INDEX development_review_session ON development_reviews(session_id,task_id,revision DESC);
CREATE TRIGGER development_review_immutable_update BEFORE UPDATE ON development_reviews
BEGIN SELECT RAISE(ABORT,'review evidence is immutable'); END;
CREATE TRIGGER development_review_immutable_delete BEFORE DELETE ON development_reviews
BEGIN SELECT RAISE(ABORT,'review evidence is immutable'); END;
CREATE TRIGGER development_review_projection AFTER INSERT ON development_reviews BEGIN
  INSERT OR IGNORE INTO merge_display_dirty(kind,id) SELECT 'delivery',id FROM merge_delivery_projection WHERE session_id=NEW.session_id; END;
CREATE TRIGGER development_review_policy_projection AFTER INSERT ON development_review_policy BEGIN
  INSERT OR IGNORE INTO merge_display_dirty(kind,id) SELECT 'delivery',id FROM merge_delivery_projection WHERE session_id=NEW.session_id; END;
CREATE TRIGGER development_review_policy_changed AFTER UPDATE ON development_review_policy
WHEN OLD.unavailable IS NOT NEW.unavailable OR OLD.active_task_id IS NOT NEW.active_task_id BEGIN
  INSERT OR IGNORE INTO merge_display_dirty(kind,id) SELECT 'delivery',id FROM merge_delivery_projection WHERE session_id=NEW.session_id; END;`;
const sha = z.string().regex(/^[a-f0-9]{40}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.object({ version: z.literal(1), taskId: z.string().regex(/^[A-Za-z0-9_-]{1,150}$/),
  agentKind: z.enum(["codex", "claude_code", "opencode"]), sessionRef: z.string().min(1).max(200), requestId: z.string().min(1).max(16000),
  scopeDigest: digest, revision: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  status: z.enum(["developing", "reviewing", "repairing", "validating", "passed", "incomplete", "exhausted", "cancelled", "needs_decision", "unsupported"]),
  round: z.number().int().min(0).max(3), base: sha, repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(), candidateDigest: digest.optional(), checksPassed: z.boolean(),
  blockingFindings: z.number().int().min(0).max(50), limitations: z.array(z.string().max(16000)).max(33),
  findings: z.array(z.object({id:z.string().max(150),severity:z.enum(["blocking","advisory"]),path:z.string().max(16000),trigger:z.string().max(16000),expected:z.string().max(16000),actual:z.string().max(16000),evidence:z.string().max(16000),validation:z.string().max(16000)}).strict()).max(50).optional(),
  checks: z.array(z.object({name:z.string().min(1).max(16000),method:z.string().min(1).max(16000),result:z.enum(["passed","failed","not_run"]),evidence:z.string().min(1).max(16000)}).strict()).max(32).optional(),
  requiredChecks: z.array(z.string().min(1).max(16000)).min(1).max(32).optional(),
  reviewer: z.object({sessionRef:z.string().min(1).max(200),model:z.string().min(1).max(500),provider:z.string().min(1).max(500),readOnly:z.boolean()}).strict().optional(),
  proof: z.object({ checkedAt: z.string().datetime(), head: sha, base: sha, candidateDigest: digest, clean: z.boolean(), valid: z.boolean() }).strict().optional(),
}).strict();

/** Called only after the existing node snapshot ownership/generation checks.
 * MCP model-written comments and normal session text cannot write this table. */
export function recordDevelopmentReviews(db: MissionGoDatabase, nodeId: string, sessionId: string, input: unknown, required?: unknown, activeTaskId?: unknown) {
  if (input === undefined && required === undefined) return;
  if (required !== undefined && typeof required !== "boolean") throw invalidInput("Invalid development review policy.");
  const parsed = z.array(evidence).max(32).safeParse(input ?? []);
  if (!parsed.success) throw invalidInput("Invalid development review evidence.");
  if (activeTaskId !== undefined && (typeof activeTaskId !== "string" || !parsed.data.some(value => value.taskId === activeTaskId))) throw invalidInput("Active review must be present in this snapshot.");
  const owner = db.connection.prepare(`SELECT agent_kind,agent_session_ref AS session_ref FROM agent_sessions WHERE id=? AND node_id=?
    UNION ALL SELECT agent_kind,session_ref FROM external_agent_sessions WHERE id=? AND native_node_id=?`).get(sessionId,nodeId,sessionId,nodeId) as {agent_kind:string;session_ref:string}|undefined;
  if (!owner) throw conflict("review_evidence_conflict", "Review evidence must belong to the reporting native node.");
  db.transaction(() => {
    if (required === true) db.connection.prepare("INSERT OR IGNORE INTO development_review_policy(session_id,node_id,required) VALUES (?,?,1)").run(sessionId,nodeId);
    if (required === true || parsed.data.length) {
      db.connection.prepare("INSERT OR IGNORE INTO development_review_policy(session_id,node_id,required) VALUES (?,?,1)").run(sessionId,nodeId);
      db.connection.prepare("UPDATE development_review_policy SET unavailable=? WHERE session_id=? AND node_id=?")
        .run(input === undefined || parsed.data.some(value => value.revision === 0) ? 1 : 0,sessionId,nodeId);
    }
    if (activeTaskId !== undefined) db.connection.prepare("UPDATE development_review_policy SET active_task_id=? WHERE session_id=? AND node_id=?").run(activeTaskId as string,sessionId,nodeId);
    for (const value of parsed.data) {
      if (value.agentKind !== owner.agent_kind || value.sessionRef !== owner.session_ref) throw invalidInput("Review source identity mismatch.");
      const json = JSON.stringify(value), hash = createHash("sha256").update(json).digest("hex");
      const old = db.connection.prepare("SELECT revision,generation,digest FROM development_reviews WHERE session_id=? AND task_id=? ORDER BY revision DESC LIMIT 1").get(sessionId,value.taskId) as {revision:number;generation:number;digest:string}|undefined;
      if (old && value.revision < old.revision) continue;
      if (old && value.revision === old.revision) { if (old.digest !== hash) throw conflict("review_evidence_conflict", "Review revision already has different evidence."); continue; }
      if (old && value.generation < old.generation) throw conflict("review_evidence_conflict", "Review generation cannot move backwards.");
      db.connection.prepare("INSERT INTO development_reviews(session_id,node_id,task_id,revision,generation,digest,payload_json,recorded_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(sessionId,nodeId,value.taskId,value.revision,value.generation,hash,json,new Date().toISOString());
    }
  });
}
export function sessionDevelopmentReviews(db: MissionGoDatabase, sessionId: string): DevelopmentReviewEvidence[] {
  const rows = db.connection.prepare(`SELECT payload_json FROM development_reviews d WHERE session_id=? AND revision=(
    SELECT MAX(revision) FROM development_reviews p WHERE p.session_id=d.session_id AND p.task_id=d.task_id) ORDER BY sequence DESC LIMIT 32`).all(sessionId) as {payload_json:string}[];
  return rows.map(row => JSON.parse(row.payload_json) as DevelopmentReviewEvidence);
}
function activeReview(db: MissionGoDatabase, sessionId: string) {
  const policy = db.connection.prepare(`SELECT p.unavailable,(SELECT payload_json FROM development_reviews r WHERE r.session_id=p.session_id
    AND (p.active_task_id IS NULL OR r.task_id=p.active_task_id) ORDER BY sequence DESC LIMIT 1) AS payload_json
    FROM development_review_policy p WHERE session_id=?`).get(sessionId) as {unavailable:number;payload_json:string|null}|undefined;
  return policy ? {unavailable:Boolean(policy.unavailable),review:policy.payload_json ? JSON.parse(policy.payload_json) as DevelopmentReviewEvidence : undefined} : undefined;
}
export function developmentReviewExpiry(db: MissionGoDatabase, sessionId: string) {
  const proof = activeReview(db,sessionId)?.review?.proof;
  return proof ? Date.parse(proof.checkedAt)+300000 : undefined;
}
export function developmentReviewBlocker(db: MissionGoDatabase, sessionId: string, head: string, base: string, repository?: string): string | undefined {
  const active = activeReview(db,sessionId);
  // Unchanged contract for historical sessions without a recorded policy.
  if (!active) return undefined;
  if (active.unavailable) return "review_incomplete";
  const selected=active.review;
  if (!selected) return "review_missing";
  for (const review of [selected]) {
    const proof = review.proof, age = proof ? Date.now()-Date.parse(proof.checkedAt) : Infinity;
    if (review.status !== "passed" || !review.reviewer?.readOnly || !review.checksPassed || review.blockingFindings || review.limitations.length) return "review_incomplete";
    if (!review.requiredChecks?.length || !review.requiredChecks.every(name => review.checks?.some(check => check.name === name && check.result === "passed")) || review.findings?.some(finding => finding.severity === "blocking")) return "review_incomplete";
    if (repository && review.repository !== repository) return "review_stale";
    if (!proof?.valid || !proof.clean || proof.head !== head || proof.base !== base || review.base !== base
      || proof.candidateDigest !== review.candidateDigest || age < -30000 || age > 300000) return "review_stale";
  }
  return undefined;
}
export function developmentReviewSummary(db: MissionGoDatabase, sessionId: string) {
  const records = sessionDevelopmentReviews(db,sessionId);
  const required = records.length > 0 || Boolean(db.connection.prepare("SELECT 1 FROM development_review_policy WHERE session_id=?").get(sessionId));
  const policy = db.connection.prepare("SELECT active_task_id FROM development_review_policy WHERE session_id=?").get(sessionId) as {active_task_id:string|null}|undefined;
  return required ? {required,records,...(policy?.active_task_id ? {activeTaskId:policy.active_task_id} : {})} : undefined;
}
