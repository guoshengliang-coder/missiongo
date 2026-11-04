import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CompletionReference } from "@missiongo/contracts";
import type { MissionGoStore } from "./store.js";
import { deliveryRound } from "./delivery-round.js";
import { assertBuilderExecution, latestBuilderHandover } from "./builder-authority.js";
import { itemRoles } from "./item-policy.js";
import { conflict, notFound } from "./errors.js";

const candidate = z.object({
  completion: z.discriminatedUnion("kind", [
    z.object({kind:z.literal("github"),url:z.string().url().max(500)}),
    z.object({kind:z.literal("gitlab"),url:z.string().url().max(500)}),
    z.object({kind:z.literal("commit"),commit:z.string().regex(/^[a-f0-9]{40}$/),targetBranch:z.string().min(1).max(200)}),
  ]),
  title:z.string().max(500), state:z.enum(["merged","open","closed","integrated","unmerged"]),
  commentId:z.uuid().optional(),
});
export const discoveryReportSchema = z.object({
  leaseToken:z.uuid(), repository:z.string().url().max(500).optional(), candidates:z.array(candidate).max(30),
  failure:z.enum(["permission_failed","failed"]).optional(),
});
type Hint = {kind:"github"|"gitlab"|"commit";value:string;commentId:string};
interface Row {
  id:string;item_id:string;account_id:string;round_key:string;content_version:number;status:string;
  candidates_json:string;repository:string|null;requested_at:string;lease_node_id:string|null;
  lease_token:string|null;lease_repo_path:string|null;lease_until:string|null;
}
/** Discovery supplies suggestions, never delivery evidence or an automatic association. */
export class CompletionDiscovery {
  constructor(readonly store:MissionGoStore) {}
  private get db() {return this.store.database.connection;}
  private row(id:string) {
    const row=this.db.prepare("SELECT * FROM completion_discoveries WHERE id=?").get(id) as unknown as Row|undefined;
    if (!row) throw notFound("Discovery");return row;
  }
  private valid(row:Row) {
    const item=this.db.prepare("SELECT status,content_version,product_id FROM work_items WHERE id=?").get(row.item_id) as {status:string;content_version:number;product_id:string};
    const builder=latestBuilderHandover(this.store.database,row.item_id);
    return deliveryRound(this.store.database,row.item_id)===row.round_key && item.content_version===row.content_version
      && ["in_progress","development_complete","ready","inbox"].includes(item.status)
      && !this.store.getProduct(item.product_id).archivedAt && (!builder || builder.status==="completed")
      && !this.db.prepare("SELECT 1 FROM item_transfers WHERE source_item_id=?").get(row.item_id);
  }
  private currentResult(row:Row) {
    if (!this.db.prepare("SELECT 1 FROM node_product_repos WHERE node_id=? AND product_id=? AND repo_path=?")
      .get(row.lease_node_id,this.productId(row.id),row.lease_repo_path)) return false;
    const hints=this.hints(row);
    return (JSON.parse(row.candidates_json) as z.infer<typeof candidate>[])
      .every(c=>!c.commentId || hints.some(h=>h.commentId===c.commentId));
  }
  snapshot(itemKey:string) {
    const item=this.store.getWorkItem(itemKey);
    const row=this.db.prepare("SELECT * FROM completion_discoveries WHERE item_id=? ORDER BY (round_key=?) DESC,requested_at DESC,rowid DESC LIMIT 1").get(item.id,deliveryRound(this.store.database,item.id)) as unknown as Row|undefined;
    if (!row) return null;
    const valid=this.valid(row) && (row.status!=="found" || this.currentResult(row));
    return {id:row.id,status:valid?row.status:"stale",repository:row.repository,
      candidates:valid&&row.status==="found"?JSON.parse(row.candidates_json) as z.infer<typeof candidate>[]:[]};
  }
  request(itemKey:string,accountId:string,rediscover=false) {
    this.store.assertWorkItemWritable(itemKey);
    const item=this.store.getWorkItem(itemKey);
    assertBuilderExecution(this.store.database,item.id,accountId,!itemRoles(this.store.database,item,accountId).manager);
    const round=deliveryRound(this.store.database,item.id);
    if (!round || !["in_progress","development_complete","ready","inbox"].includes(item.status)) throw conflict("handover_round_missing","A current processing round is required.");
    const now=new Date().toISOString();
    const previous=this.db.prepare("SELECT * FROM completion_discoveries WHERE item_id=? AND round_key=?")
      .get(item.id,round) as unknown as Row|undefined;
    if (previous && previous.account_id===accountId && this.valid(previous)) {
      // Opening a status action is not a request to throw away usable results.
      // Even an explicit retry must not steal an active worker's lease.
      if (previous.status==="checking" && previous.lease_until && previous.lease_until>now
        || !rediscover && (previous.status==="waiting_node" || previous.status==="found" && this.currentResult(previous)))
        return this.snapshot(itemKey);
    }
    this.db.prepare(`INSERT INTO completion_discoveries(id,item_id,account_id,round_key,content_version,status,requested_at)
      VALUES (?,?,?,?,?,'waiting_node',?) ON CONFLICT(item_id,round_key) DO UPDATE SET
      account_id=excluded.account_id,content_version=excluded.content_version,status='waiting_node',
      candidates_json='[]',repository=NULL,lease_node_id=NULL,lease_token=NULL,lease_repo_path=NULL,lease_until=NULL,
      requested_at=excluded.requested_at`).run(randomUUID(),item.id,accountId,round,item.contentVersion ?? 1,now);
    return this.snapshot(itemKey);
  }
  hints(row:Row):Hint[] {
    const comments=this.db.prepare(`SELECT id,body_json,summary FROM work_item_comments WHERE item_id=? AND withdrawn_at IS NULL
      AND history_source_key IS NULL AND timeline_seq>=(SELECT timeline_seq FROM work_item_events WHERE id=?)
      ORDER BY timeline_seq DESC LIMIT 100`).all(row.item_id,row.round_key) as {id:string;body_json:string;summary:string|null}[];
    const hints:Hint[]=[];
    for (const c of comments) {
      const text=`${c.summary ?? ""} ${c.body_json}`.slice(0,24000);
      for (const m of text.matchAll(/https:\/\/[^\s"<>\\]+\/(?:pull\/|-\/merge_requests\/)\d+|\b(?:PR|MR)\s*#?\s*(\d+)\b|\b([a-f0-9]{7,40})\b/gi)) {
        const value=m[2]?.toLowerCase() ?? m[1] ?? m[0];
        const kind=m[2]?"commit":/merge_requests|^MR/i.test(m[0])?"gitlab":"github";
        if (!hints.some(h=>h.kind===kind&&h.value===value)) hints.push({kind,value,commentId:c.id});
        if (hints.length>=30) return hints;
      }
    }
    return hints;
  }
  claim(nodeId:string,accountId:string,allowed:(productId:string)=>void) {
    const now=new Date().toISOString();
    const rows=this.db.prepare(`SELECT d.*,r.repo_path,w.product_id,w.item_key FROM completion_discoveries d
      JOIN work_items w ON w.id=d.item_id JOIN node_product_repos r ON r.product_id=w.product_id AND r.node_id=?
      WHERE d.account_id=? AND d.status IN ('waiting_node','checking') AND (d.lease_until IS NULL OR d.lease_until<?)
      ORDER BY d.requested_at LIMIT 50`).all(nodeId,accountId,now) as unknown as (Row&{repo_path:string;product_id:string;item_key:string})[];
    for (const row of rows) {
      try {allowed(row.product_id);} catch {continue;}
      if (!this.valid(row)) {this.db.prepare("UPDATE completion_discoveries SET status='stale' WHERE id=?").run(row.id);continue;}
      const leaseToken=randomUUID();
      const updated=this.db.prepare(`UPDATE completion_discoveries SET status='checking',lease_node_id=?,lease_token=?,lease_repo_path=?,lease_until=?
        WHERE id=? AND (lease_until IS NULL OR lease_until<?)`).run(nodeId,leaseToken,row.repo_path,new Date(Date.now()+600000).toISOString(),row.id,now);
      if (updated.changes) return {id:row.id,productId:row.product_id,itemKey:row.item_key,repoPath:row.repo_path,leaseToken,hints:this.hints(row)};
    }
    return null;
  }
  productId(id:string) {return this.store.getWorkItem(this.itemKey(this.row(id))).productId;}
  private itemKey(row:Row) {return (this.db.prepare("SELECT item_key FROM work_items WHERE id=?").get(row.item_id) as {item_key:string}).item_key;}
  report(id:string,raw:unknown,nodeId:string,accountId:string) {
    const input=discoveryReportSchema.parse(raw),row=this.row(id);
    if (!this.valid(row) || row.account_id!==accountId || row.lease_node_id!==nodeId || row.lease_token!==input.leaseToken
      || !row.lease_until || row.lease_until<new Date().toISOString()
      || !this.db.prepare("SELECT 1 FROM node_product_repos WHERE node_id=? AND product_id=? AND repo_path=?").get(nodeId,this.productId(id),row.lease_repo_path))
      throw conflict("status_check_lease_expired","Discovery lease or processing round changed.");
    if (!input.repository && (!input.failure || input.candidates.length)) throw conflict("repository_mismatch","Missing repository identity.");
    const repo=new URL(input.repository ?? "https://invalid.example/unavailable");
    if (repo.protocol!=="https:" || repo.username || repo.password || repo.search || repo.hash) throw conflict("repository_mismatch","Invalid repository identity.");
    const hints=this.hints(row);
    for (const c of input.candidates) {
      if (c.commentId && !hints.some(h=>h.commentId===c.commentId)) throw conflict("discovery_source_changed","The source comment changed.");
      if ("url" in c.completion) {
        const prefix=`${input.repository}/${c.completion.kind==="github"?"pull/":"-/merge_requests/"}`;
        if (!c.completion.url.startsWith(prefix) || !/^[1-9]\d*$/.test(c.completion.url.slice(prefix.length))) throw conflict("repository_mismatch","Candidate belongs to another repository.");
      }
    }
    this.db.prepare(`UPDATE completion_discoveries SET status=?,candidates_json=?,repository=?,lease_until=NULL,lease_token=NULL WHERE id=?`)
      .run(input.failure ?? (input.candidates.length?"found":"empty"),JSON.stringify(input.candidates),input.repository ?? null,id);
    return this.snapshot(this.itemKey(row));
  }
  assertSelection(itemKey:string,id:string,index:number,completion:CompletionReference) {
    const row=this.row(id),snapshot=this.snapshot(itemKey);
    if (this.itemKey(row)!==itemKey || !this.valid(row) || snapshot?.id!==id) throw conflict("discovery_stale","Refresh candidates before associating completion.");
    if (!this.db.prepare("SELECT 1 FROM node_product_repos WHERE node_id=? AND product_id=? AND repo_path=?")
      .get(row.lease_node_id,this.productId(id),row.lease_repo_path)) throw conflict("discovery_stale","The repository mapping changed; search again.");
    if (snapshot.status!=="found" || JSON.stringify(snapshot.candidates[index]?.completion)!==JSON.stringify(completion)) throw conflict("discovery_stale","Refresh candidates before associating completion.");
    const c=snapshot.candidates[index];
    if (c?.commentId && !this.hints(row).some(h=>h.commentId===c.commentId)) throw conflict("discovery_source_changed","The source comment changed.");
  }
}
