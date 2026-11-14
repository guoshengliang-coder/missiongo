import type { ServerContext } from "@modelcontextprotocol/server";
import { createHash, randomUUID } from "node:crypto";
import { conflict } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export const planDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface ApprovalRow { revision: string; plan_hash: string; scope_json: string; command_id: string | null }
export interface ImplementationPlanState {
  revision: string; approved: boolean; valid: boolean;
  origin?: "native" | "attention"; approvedAt?: string; requestedAt?: string; nativeSourceId?: string;
}

/** Approval facts are written only by an authenticated human route, native elicitation response,
 * or an exact native implementation instruction bound to the original pending plan.
 * No MCP argument, prose classifier, setting change or tool approval can grant this authority. */
export class ImplementationPlans {
  constructor(private readonly db: MissionGoDatabase) {}

  scope(keys: readonly string[]): string {
    return JSON.stringify([...new Set(keys)].sort().map(key => {
      const item = this.db.connection.prepare(`SELECT id,content_version FROM work_items WHERE item_key=?`).get(key) as {id:string;content_version:number}|undefined;
      if (!item) throw conflict("implementation_plan_changed", "The approved item no longer exists.");
      const boundary = this.db.connection.prepare(`SELECT id FROM work_item_events WHERE item_id=? AND history_source_key IS NULL
        AND (event_type='builder_changed' AND json_extract(payload_json,'$.handoverId') IS NOT NULL OR event_type='status_changed' AND (to_status IN ('cancelled','done') OR to_status='ready' AND COALESCE(json_extract(payload_json,'$.reason'),'')!='verification_failed'))
        ORDER BY timeline_seq DESC LIMIT 1`).get(item.id) as {id:string}|undefined;
      return { key, contentVersion: item.content_version, boundary: boundary?.id ?? null };
    }));
  }

  dispatchKeys(dispatchId: string): string[] {
    return (this.db.connection.prepare(`SELECT w.item_key AS key FROM dispatch_items d JOIN work_items w ON w.id=d.item_id
      WHERE d.dispatch_id=? ORDER BY w.item_key`).all(dispatchId) as {key:string}[]).map(row => row.key);
  }

  request(accountId: string, identity: string, revision: string, proposal?: {keys: readonly string[];plan:string;validation:string;documentId?:string;origin?:"native"|"attention"}): void {
    this.db.transaction(() => {
    const previous=this.db.connection.prepare("SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?").get(accountId,identity) as {revision:string}|undefined;
    if(previous?.revision===revision) return;
    this.db.connection.prepare(`INSERT INTO implementation_plan_requests(account_id,identity_key,revision,proposal_json,scope_json) VALUES (?,?,?,?,?)
      ON CONFLICT(account_id,identity_key) DO UPDATE SET revision=excluded.revision,proposal_json=excluded.proposal_json,scope_json=excluded.scope_json`)
      .run(accountId,identity,revision,proposal ? JSON.stringify({...proposal,submittedAt:new Date().toISOString(),requestedAt:new Date().toISOString()}) : null,proposal ? this.scope(proposal.keys) : null);
    });
  }

  proposal(accountId:string,identity:string): {revision:string;keys:string[];plan:string;validation:string;documentId?:string;origin?:"native"|"attention";submittedAt?:string;approvedAt?:string;requestedAt?:string;nativeSourceId?:string;approved:boolean;valid:boolean}|undefined {
    const row=this.db.connection.prepare("SELECT revision,proposal_json,scope_json FROM implementation_plan_requests WHERE account_id=? AND identity_key=?")
      .get(accountId,identity) as {revision:string;proposal_json:string|null;scope_json:string|null}|undefined;
    if(!row?.proposal_json) return undefined;
    const proposal=JSON.parse(row.proposal_json) as {keys:string[];plan:string;validation:string;documentId?:string;submittedAt?:string};
    const approval=this.db.connection.prepare("SELECT approved_at FROM implementation_plan_approvals WHERE account_id=? AND identity_key=? AND revision=?")
      .get(accountId,identity,row.revision) as {approved_at:string}|undefined;
    const documentRow = proposal.documentId ? this.db.connection.prepare("SELECT document_json FROM plan_documents WHERE id=?").get(proposal.documentId) as {document_json:string}|undefined : undefined;
    const roundsMatch = !proposal.documentId || Boolean(documentRow && (JSON.parse(documentRow.document_json) as {rounds:{key:string;eventId:string|null}[]}).rounds.every(round=>{
      const latest=this.db.connection.prepare(`SELECT e.id FROM work_item_events e JOIN work_items w ON w.id=e.item_id
        WHERE w.item_key=? AND e.history_source_key IS NULL AND e.event_type='status_changed'
        AND json_extract(e.payload_json,'$.reason')='verification_failed' ORDER BY e.timeline_seq DESC LIMIT 1`).get(round.key) as {id:string}|undefined;
      return (latest?.id ?? null)===round.eventId;
    }));
    return {...proposal,...(approval ? {approvedAt:approval.approved_at} : {}),revision:row.revision,approved:this.approved(accountId,identity,row.revision),valid:this.scope(proposal.keys)===row.scope_json && (Boolean(approval)||roundsMatch)};
  }

  /** Request-local list metadata. Never fetch plan text or retain a permission/
   * scope result across requests; the approving action still uses proposal(). */
  listStates(accountId: string, identities: readonly string[]): ReadonlyMap<string, ImplementationPlanState> {
    const result = new Map<string, ImplementationPlanState>();
    if (!identities.length) return result;
    const rows = this.db.connection.prepare(`SELECT r.identity_key,r.revision,r.scope_json,
      json_extract(r.proposal_json,'$.keys') AS keys_json,
      json_extract(r.proposal_json,'$.documentId') AS document_id,
      json_extract(r.proposal_json,'$.origin') AS origin,
      json_extract(r.proposal_json,'$.requestedAt') AS requested_at,
      json_extract(r.proposal_json,'$.nativeSourceId') AS native_source_id,
      a.approved_at,a.plan_hash,a.scope_json AS approved_scope
      FROM implementation_plan_requests r LEFT JOIN implementation_plan_approvals a
        ON a.account_id=r.account_id AND a.identity_key=r.identity_key AND a.revision=r.revision
      WHERE r.account_id=? AND r.identity_key IN (SELECT value FROM json_each(?)) AND r.proposal_json IS NOT NULL`)
      .all(accountId, JSON.stringify([...new Set(identities)])) as unknown as Array<{
        identity_key:string; revision:string; scope_json:string|null; keys_json:string; document_id:string|null;
        origin:ImplementationPlanState["origin"]|null; requested_at:string|null; native_source_id:string|null;
        approved_at:string|null; plan_hash:string|null; approved_scope:string|null;
      }>;
    if (!rows.length) return result;
    const entries = rows.map(row => ({ row, keys: JSON.parse(row.keys_json) as string[],
      approvedKeys: row.approved_scope ? (JSON.parse(row.approved_scope) as {key:string}[]).map(entry => entry.key) : [] }));
    const documentIds = [...new Set(rows.flatMap(row => row.document_id ? [row.document_id] : []))];
    const documents = new Map((documentIds.length ? this.db.connection.prepare(`SELECT id,json_extract(document_json,'$.rounds') AS rounds_json
      FROM plan_documents WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(documentIds)) as {id:string;rounds_json:string}[] : [])
      .map(row => [row.id, JSON.parse(row.rounds_json) as {key:string;eventId:string|null}[]]));
    const keys = [...new Set([...entries.flatMap(entry => [...entry.keys,...entry.approvedKeys]),
      ...[...documents.values()].flatMap(rounds => rounds.map(round => round.key))])];
    const facts = new Map((keys.length ? this.db.connection.prepare(`SELECT w.item_key,w.content_version,
      (SELECT e.id FROM work_item_events e WHERE e.item_id=w.id AND e.history_source_key IS NULL
        AND (e.event_type='builder_changed' AND json_extract(e.payload_json,'$.handoverId') IS NOT NULL
          OR e.event_type='status_changed' AND (e.to_status IN ('cancelled','done') OR e.to_status='ready'
            AND COALESCE(json_extract(e.payload_json,'$.reason'),'')!='verification_failed'))
        ORDER BY e.timeline_seq DESC LIMIT 1) AS boundary,
      (SELECT e.id FROM work_item_events e WHERE e.item_id=w.id AND e.history_source_key IS NULL AND e.event_type='status_changed'
        AND json_extract(e.payload_json,'$.reason')='verification_failed' ORDER BY e.timeline_seq DESC LIMIT 1) AS round
      FROM work_items w WHERE w.item_key IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys)) as {
        item_key:string;content_version:number;boundary:string|null;round:string|null;
      }[] : []).map(row => [row.item_key,row]));
    const scope = (selected: readonly string[]) => JSON.stringify([...new Set(selected)].sort().map(key => {
      const fact = facts.get(key);
      if (!fact) throw conflict("implementation_plan_changed", "The approved item no longer exists.");
      return {key,contentVersion:fact.content_version,boundary:fact.boundary};
    }));
    for (const {row,keys,approvedKeys} of entries) {
      const rounds = row.document_id ? documents.get(row.document_id) : undefined;
      const roundsMatch = !row.document_id || Boolean(rounds?.every(round => (facts.get(round.key)?.round ?? null) === round.eventId));
      result.set(row.identity_key, {revision:row.revision,
        approved: row.plan_hash === row.revision && row.approved_scope === scope(approvedKeys),
        valid: scope(keys) === row.scope_json && (Boolean(row.approved_at) || roundsMatch),
        ...(row.origin ? {origin:row.origin} : {}), ...(row.approved_at ? {approvedAt:row.approved_at} : {}),
        ...(row.requested_at ? {requestedAt:row.requested_at} : {}), ...(row.native_source_id ? {nativeSourceId:row.native_source_id} : {}),
      });
    }
    return result;
  }

  assertRequest(accountId:string,identity:string,revision:string): void {
    const row=this.db.connection.prepare("SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?").get(accountId,identity) as {revision:string}|undefined;
    if(row?.revision!==revision) throw conflict("implementation_plan_changed","A newer plan superseded this approval request.");
  }

  record(input: { accountId: string; identity: string; revision: string; planHash: string; keys: readonly string[];
    source: "web" | "native"; commandId?: string; plan?:string; validation?:string }): void {
    this.db.transaction(() => {
    this.request(input.accountId,input.identity,input.revision);
    this.db.connection.prepare(`INSERT INTO implementation_plan_approvals
      (id,account_id,identity_key,revision,plan_hash,scope_json,plan_text,validation_text,source,command_id,approved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,identity_key,revision) DO NOTHING`)
      .run(randomUUID(),input.accountId,input.identity,input.revision,input.planHash,this.scope(input.keys),
        input.plan ?? "",input.validation ?? "",input.source,input.commandId ?? null,new Date().toISOString());
    });
  }

  approved(accountId: string, identity: string, planHash: string): boolean {
    const row=this.db.connection.prepare(`SELECT scope_json FROM implementation_plan_approvals
      WHERE account_id=? AND identity_key=? AND plan_hash=? AND revision=(SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?)`)
      .get(accountId,identity,planHash,accountId,identity) as {scope_json:string}|undefined;
    if(!row) return false;
    return row.scope_json===this.scope((JSON.parse(row.scope_json) as {key:string}[]).map(entry=>entry.key));
  }

  assertApprovedScope(accountId: string, identity: string, key: string): void {
    const rows = this.db.connection.prepare(`SELECT revision,plan_hash,scope_json,command_id FROM implementation_plan_approvals
      WHERE account_id=? AND identity_key=? AND revision=(SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?) ORDER BY approved_at DESC,rowid DESC LIMIT 1`).all(accountId,identity,accountId,identity) as unknown as ApprovalRow[];
    const row = rows[0];
    if (row) {
      const keys = (JSON.parse(row.scope_json) as {key:string}[]).map(entry => entry.key);
      if (keys.includes(key) && row.scope_json === this.scope(keys)) {
        return;
      }
    }
    throw conflict("implementation_plan_approval_required", "The current implementation plan has no approval for this scope. Claiming responsibility and native permissions are independent.");
  }

  canImplement(accountId:string,identity:string): boolean {
    const row=this.db.connection.prepare(`SELECT scope_json FROM implementation_plan_approvals WHERE account_id=? AND identity_key=?
      AND revision=(SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?) ORDER BY rowid DESC LIMIT 1`)
      .get(accountId,identity,accountId,identity) as {scope_json:string}|undefined;
    if(!row) return false;
    const keys=(JSON.parse(row.scope_json) as {key:string}[]).map(entry=>entry.key);
    return row.scope_json===this.scope(keys);
  }

  hasRequest(accountId: string, identity: string): boolean {
    return Boolean(this.db.connection.prepare("SELECT 1 FROM implementation_plan_requests WHERE account_id=? AND identity_key=?")
      .get(accountId, identity));
  }

  attachCommand(accountId:string,identity:string,revision:string,commandId:string): void {
    this.db.connection.prepare(`UPDATE implementation_plan_approvals SET command_id=?
      WHERE account_id=? AND identity_key=? AND revision=? AND command_id IS NULL`).run(commandId,accountId,identity,revision);
  }

  /** The original native caller has continued. Cancel only our unsent handoff;
   * never touch human input, in-flight or uncertain deliveries. */
  nativeContinued(accountId:string,identity:string,revision:string): void {
    this.db.transaction(()=>{
      const row=this.db.connection.prepare(`SELECT command_id FROM implementation_plan_approvals
        WHERE account_id=? AND identity_key=? AND revision=?`).get(accountId,identity,revision) as {command_id:string|null}|undefined;
      if(row?.command_id) for(const table of ["agent_session_commands","external_native_commands"]) {
        this.db.connection.prepare(`UPDATE ${table} SET status='cancelled',cancelled_at=? WHERE id=? AND status='queued'`)
          .run(new Date().toISOString(),row.command_id);
      }
      this.db.connection.prepare(`UPDATE implementation_plan_continuations SET state='cancelled'
        WHERE account_id=? AND identity_key=? AND revision=? AND state IN ('waiting','queued')`)
        .run(accountId,identity,revision);
    });
  }

  commandRevision(commandId: string): string | undefined {
    return (this.db.connection.prepare("SELECT revision FROM implementation_plan_approvals WHERE command_id=?").get(commandId) as {revision:string}|undefined)?.revision;
  }
}

/** Only the native client's elicitation result is accepted, never a tool argument. */
export async function requestNativePlanApproval(ctx: ServerContext, message: string, revision: string): Promise<boolean> {
  const result=await ctx.mcpReq.elicitInput({mode:"form",message,
    requestedSchema:{type:"object",properties:{},required:[],additionalProperties:false},
    _meta:{"missiongo/planApproval":revision}});
  return result.action==="accept";
}
