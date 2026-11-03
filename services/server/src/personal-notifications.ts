import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PersonalNotificationDetail, PersonalNotificationFilter, PersonalNotificationKind, PersonalNotificationPage } from "@missiongo/domain";
import { AccountStore, type AccountSnapshot } from "./accounts-store.js";
import type { MissionGoDatabase } from "./storage/database.js";
import type { MissionGoStore } from "./store.js";
import { invalidInput, notFound } from "./errors.js";

/** Caller owns the business transaction. Recipient and event identity deduplicate
 * mentions/replies and retries independently of any delivery provider. */
export function enqueuePersonalNotification(database: MissionGoDatabase, input: {
  itemId: string; productId: string; accountId: string; kind: PersonalNotificationKind;
  businessEventId?: string; commentId?: string; createdAt: string;
}): string | undefined {
  const accounts = new AccountStore(database), account = accounts.findActive(input.accountId);
  if (!account || !accounts.allows(account, input.productId, "view")) return;
  const db = database.connection;
  const sourceId = input.commentId ?? input.businessEventId!;
  db.prepare(`INSERT OR IGNORE INTO notification_events(id,item_id,business_event_id,comment_id,created_at) VALUES (?,?,?,?,?)`)
    .run(sourceId,input.itemId,input.businessEventId ?? null,input.commentId ?? null,input.createdAt);
  db.prepare(`INSERT OR IGNORE INTO personal_notifications(id,event_id,account_id,kind) VALUES (?,?,?,?)`)
    .run(randomUUID(),sourceId,input.accountId,input.kind);
  return (db.prepare("SELECT id FROM personal_notifications WHERE event_id=? AND account_id=?").get(sourceId,input.accountId) as {id:string}).id;
}

interface Row {
  id:string; sequence:number; kind:PersonalNotificationKind; read_at:string|null; created_at:string;
  item_key:string; title:string; product_id:string; product_name:string; comment_id:string|null;
  withdrawn_at:string|null; body_json:string|null; summary:string|null; actor_id:string|null; agent_name:string|null;
  payload_json:string|null;
}
const joins = `FROM personal_notifications n JOIN notification_events e ON e.id=n.event_id
  JOIN work_items w ON w.id=e.item_id JOIN products p ON p.id=w.product_id
  LEFT JOIN work_item_comments c ON c.id=e.comment_id
  LEFT JOIN work_item_events b ON b.id=e.business_event_id`;
const select = `SELECT n.id,n.sequence,n.kind,n.read_at,e.created_at,w.item_key,w.title,w.product_id,p.name AS product_name,
  e.comment_id,c.withdrawn_at,c.body_json,c.summary,coalesce(c.account_id,b.account_id) AS actor_id,c.agent_name,b.payload_json ${joins}`;

export class PersonalNotifications {
  constructor(private store: MissionGoStore, private accounts: AccountStore) {}
  private get db() { return this.store.database.connection; }
  private scope(account: AccountSnapshot) {
    // Use the same capability check as item reads (including project administrators).
    const ids = this.store.listProducts({includeArchived:true}).filter(p => this.accounts.allows(account,p.id,"view")).map(p=>p.id);
    return {sql:`n.account_id=? AND w.product_id IN (${ids.map(()=>"?").join(",") || "NULL"})`,args:[account.id,...ids]};
  }
  private filter(filter: PersonalNotificationFilter) {
    const sql:string[]=[],args:(string|number)[]=[];
    if(filter.unread) sql.push("n.read_at IS NULL");
    if(filter.productId) {sql.push("w.product_id=?");args.push(filter.productId);}
    if(filter.kind) {sql.push("n.kind=?");args.push(filter.kind);}
    return {sql:sql.length ? ` AND ${sql.join(" AND ")}` : "",args};
  }
  private snapshot(row: Row): PersonalNotificationDetail {
    const unavailable = Boolean(row.comment_id && (!row.body_json || row.withdrawn_at));
    let text = "";
    if (!unavailable && row.body_json) {
      const body = JSON.parse(row.body_json) as Record<string,unknown>;
      text = typeof body.text === "string" ? body.text : [body.understanding,body.finding,...(Array.isArray(body.evidence)?body.evidence:[]),body.proposal,...(Array.isArray(body.openQuestions)?body.openQuestions:[])].filter(v=>typeof v==="string").join("\n\n");
    } else if (!row.comment_id && row.payload_json) {
      const payload = JSON.parse(row.payload_json) as Record<string,unknown>;
      text = [payload.note,payload.summary,payload.reason].filter(v=>typeof v==="string").join("\n\n");
    }
    return {id:row.id,sequence:row.sequence,kind:row.kind,readAt:row.read_at,createdAt:row.created_at,
      itemKey:row.item_key,itemTitle:row.title,productId:row.product_id,productName:row.product_name,
      actorName:row.agent_name || (row.actor_id ? this.accounts.displayNames([row.actor_id]).get(row.actor_id) : undefined) || "",
      summary:unavailable ? "" : (row.summary || text).slice(0,240),text,commentId:row.comment_id,unavailable};
  }
  count(account: AccountSnapshot) {
    const scope=this.scope(account);
    return (this.db.prepare(`SELECT count(*) AS count ${joins} WHERE ${scope.sql} AND n.read_at IS NULL`).get(...scope.args) as {count:number}).count;
  }
  list(account: AccountSnapshot, filter: PersonalNotificationFilter): PersonalNotificationPage {
    const scope=this.scope(account),extra=this.filter(filter);
    const throughSequence=(this.db.prepare("SELECT coalesce(max(sequence),0) AS seq FROM personal_notifications WHERE account_id=?").get(account.id) as {seq:number}).seq;
    const rows=this.db.prepare(`${select} WHERE ${scope.sql}${extra.sql} AND n.sequence<? ORDER BY n.sequence DESC LIMIT 51`)
      .all(...scope.args,...extra.args,filter.beforeSequence ?? throughSequence+1) as unknown as Row[];
    const page=rows.slice(0,50);
    return {notifications:page.map(row=>{const {text:_,...summary}=this.snapshot(row);return summary;}),unreadCount:this.count(account),throughSequence,
      ...(rows.length>50 ? {nextBeforeSequence:page.at(-1)!.sequence} : {})};
  }
  detail(account: AccountSnapshot,id:string): PersonalNotificationDetail {
    const scope=this.scope(account),row=this.db.prepare(`${select} WHERE ${scope.sql} AND n.id=?`).get(...scope.args,id) as unknown as Row|undefined;
    if(!row)throw notFound("Notification");
    return this.snapshot(row);
  }
  markRead(account: AccountSnapshot,id:string) {
    this.detail(account,id);
    this.db.prepare("UPDATE personal_notifications SET read_at=coalesce(read_at,?) WHERE id=? AND account_id=?").run(new Date().toISOString(),id,account.id);
  }
  markAllRead(account: AccountSnapshot,throughSequence:number,filter:PersonalNotificationFilter) {
    const scope=this.scope(account),extra=this.filter(filter);
    this.db.prepare(`UPDATE personal_notifications SET read_at=? WHERE read_at IS NULL AND sequence<=? AND id IN
      (SELECT n.id ${joins} WHERE ${scope.sql}${extra.sql})`).run(new Date().toISOString(),throughSequence,...scope.args,...extra.args);
  }
}
const filterSchema=z.object({unread:z.enum(["true","false"]).optional().transform(v=>v==="true"),productId:z.string().max(200).optional(),
  kind:z.enum(["mention","reply","verification","decision"]).optional(),beforeSequence:z.coerce.number().int().positive().safe().optional()});
export function registerPersonalNotificationRoutes(app:FastifyInstance,{store,accounts,requireAccount}:{store:MissionGoStore;accounts:AccountStore;requireAccount:(request:FastifyRequest)=>AccountSnapshot}) {
  const service=new PersonalNotifications(store,accounts);
  const filter=(value:unknown)=>{const result=filterSchema.safeParse(value);if(!result.success)throw invalidInput("消息筛选格式无效。");return result.data;};
  app.get("/api/v1/notifications",async request=>service.list(requireAccount(request),filter(request.query)));
  app.get("/api/v1/notifications/unread-count",async request=>({count:service.count(requireAccount(request))}));
  app.get("/api/v1/notifications/:id",async request=>service.detail(requireAccount(request),(request.params as {id:string}).id));
  app.post("/api/v1/notifications/:id/read",async request=>{service.markRead(requireAccount(request),(request.params as {id:string}).id);return {ok:true};});
  app.post("/api/v1/notifications/read-all",async request=>{
    const account=requireAccount(request),body=z.object({throughSequence:z.number().int().nonnegative().safe(),filter:z.unknown().optional()}).safeParse(request.body);
    if(!body.success)throw invalidInput("消息阅读范围无效。");
    service.markAllRead(account,body.data.throughSequence,filter(body.data.filter ?? {}));return {ok:true};
  });
}
