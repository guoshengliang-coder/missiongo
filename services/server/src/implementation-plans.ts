import { normalizeAgentMode } from "@missiongo/domain";
import type { ServerContext } from "@modelcontextprotocol/server";
import { createHash, randomUUID } from "node:crypto";
import { conflict } from "./errors.js";
import type { MissionGoDatabase } from "./storage/database.js";

export const planDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface ApprovalRow { revision: string; plan_hash: string; scope_json: string; command_id: string | null }

/** Approval facts are written only by an authenticated human route, native elicitation response,
 * or the migration-frozen exact native implementation instruction recovery adapter.
 * No MCP argument, prose classifier, setting change or tool approval can grant this authority. */
export class ImplementationPlans {
  constructor(private readonly db: MissionGoDatabase) {}

  scope(keys: readonly string[]): string {
    return JSON.stringify([...new Set(keys)].sort().map(key => {
      const item = this.db.connection.prepare(`SELECT id,content_version FROM work_items WHERE item_key=?`).get(key) as {id:string;content_version:number}|undefined;
      if (!item) throw conflict("implementation_plan_changed", "The approved item no longer exists.");
      const boundary = this.db.connection.prepare(`SELECT id FROM work_item_events WHERE item_id=? AND history_source_key IS NULL
        AND (event_type='builder_changed' AND json_extract(payload_json,'$.handoverId') IS NOT NULL OR event_type='status_changed' AND to_status IN ('ready','cancelled','done'))
        ORDER BY timeline_seq DESC LIMIT 1`).get(item.id) as {id:string}|undefined;
      return { key, contentVersion: item.content_version, boundary: boundary?.id ?? null };
    }));
  }

  dispatchKeys(dispatchId: string): string[] {
    return (this.db.connection.prepare(`SELECT w.item_key AS key FROM dispatch_items d JOIN work_items w ON w.id=d.item_id
      WHERE d.dispatch_id=? ORDER BY w.item_key`).all(dispatchId) as {key:string}[]).map(row => row.key);
  }

  request(accountId: string, identity: string, revision: string, proposal?: {keys: readonly string[];plan:string;validation:string}): void {
    this.db.transaction(() => {
    const previous=this.db.connection.prepare("SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?").get(accountId,identity) as {revision:string}|undefined;
    if(previous?.revision===revision) return;
    this.db.connection.prepare(`INSERT INTO implementation_plan_requests(account_id,identity_key,revision,proposal_json,scope_json) VALUES (?,?,?,?,?)
      ON CONFLICT(account_id,identity_key) DO UPDATE SET revision=excluded.revision,proposal_json=excluded.proposal_json,scope_json=excluded.scope_json`)
      .run(accountId,identity,revision,proposal ? JSON.stringify(proposal) : null,proposal ? this.scope(proposal.keys) : null);
    });
  }

  proposal(accountId:string,identity:string): {revision:string;keys:string[];plan:string;validation:string;approved:boolean;valid:boolean}|undefined {
    const row=this.db.connection.prepare("SELECT revision,proposal_json,scope_json FROM implementation_plan_requests WHERE account_id=? AND identity_key=?")
      .get(accountId,identity) as {revision:string;proposal_json:string|null;scope_json:string|null}|undefined;
    if(!row?.proposal_json) return undefined;
    const proposal=JSON.parse(row.proposal_json) as {keys:string[];plan:string;validation:string};
    return {...proposal,revision:row.revision,approved:this.approved(accountId,identity,row.revision),valid:this.scope(proposal.keys)===row.scope_json};
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

  assertClaim(accountId: string, identity: string, key: string): void {
    const rows = this.db.connection.prepare(`SELECT revision,plan_hash,scope_json,command_id FROM implementation_plan_approvals
      WHERE account_id=? AND identity_key=? AND revision=(SELECT revision FROM implementation_plan_requests WHERE account_id=? AND identity_key=?) ORDER BY approved_at DESC,rowid DESC LIMIT 1`).all(accountId,identity,accountId,identity) as unknown as ApprovalRow[];
    const row = rows[0];
    if (row) {
      const keys = (JSON.parse(row.scope_json) as {key:string}[]).map(entry => entry.key);
      if (keys.includes(key) && row.scope_json === this.scope(keys)) {
        if(identity.startsWith("dispatch:")) {
          const session=this.db.connection.prepare(`SELECT s.agent_kind,s.mode,s.implementation_mode,s.settings_revision,s.applied_settings_revision,s.settings_error_revision,s.settings_error
            FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id WHERE d.id=? AND d.account_id=?`).get(identity.slice(9),accountId) as {agent_kind:string;mode:string|null;implementation_mode:string|null;settings_revision:number;applied_settings_revision:number;settings_error_revision:number|null;settings_error:string|null}|undefined;
          if(!session || session.applied_settings_revision<session.settings_revision
            || (session.settings_error!==null && (session.settings_error_revision ?? -1)>=session.settings_revision)
            || normalizeAgentMode(session.agent_kind,session.mode ?? "")!==normalizeAgentMode(session.agent_kind,session.implementation_mode ?? "")
            || session.agent_kind!=="codex" && session.mode==="plan") {
            throw conflict("implementation_mode_not_applied","The plan is approved, but the native implementation mode is not confirmed. Leave native Plan explicitly and wait for the node to apply the chosen mode; do not approve the plan again.");
          }
        }
        return;
      }
    }
    throw conflict("implementation_plan_approval_required", "Review the current implementation plan and approve it with the Web approval button or request_plan_approval in the native client before claiming. Mode changes and chat text are not plan approval.");
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
