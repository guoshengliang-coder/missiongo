import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PersonalAttentionCount, PersonalTodoPage, PersonalNotificationDetail, PersonalNotificationFilter, PersonalNotificationKind, PersonalNotificationPage } from "@missiongo/domain";
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
  payload_json:string|null; resolved_at:string|null; business_event_id:string|null;
}
const joins = `FROM personal_notifications n JOIN notification_events e ON e.id=n.event_id
  JOIN work_items w ON w.id=e.item_id JOIN products p ON p.id=w.product_id
  LEFT JOIN work_item_comments c ON c.id=e.comment_id
  LEFT JOIN work_item_events b ON b.id=e.business_event_id`;
// A verification notice belongs to one status entry, not the lifetime of an item.
// Derive resolution from authoritative history: GET never changes read state and
// old rounds cannot resurrect after reopening. Comments are deliberately excluded.
const resolution = `CASE WHEN n.kind='verification' THEN (
  SELECT later.created_at FROM work_item_events later
  WHERE later.item_id=w.id AND later.timeline_seq>b.timeline_seq
    AND later.history_source_key IS NULL
    AND later.event_type IN ('status_changed','item_transferred_out')
  ORDER BY later.timeline_seq LIMIT 1
) ELSE NULL END`;
// Only ordinary delivery reminders are represented by the personal todo.
// Collaboration verification has separate recipients and no equivalent todo.
const visibleNotice = `(n.kind!='verification' OR coalesce(b.event_type,'')!='status_changed' OR coalesce(b.to_status,'')!='pending_verification')`;
const needsReading = `${visibleNotice} AND n.read_at IS NULL AND (${resolution}) IS NULL`;
// Same ownership as verification delivery and human acceptance: the accessible
// non-SDK proposer. Administrator capability alone is not personal assignment.
const todoJoins = `FROM work_items w JOIN products p ON p.id=w.product_id
  JOIN work_item_events creator ON creator.id=(SELECT first.id FROM work_item_events first
    WHERE first.item_id=w.id AND first.event_type='item_created' ORDER BY first.timeline_seq,first.created_at LIMIT 1)`;
const todoWhere = `w.status='pending_verification' AND p.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM item_transfers t WHERE t.source_item_id=w.id)
  AND creator.account_id=? AND creator.actor_kind IN ('human','agent')
  AND (creator.actor_kind='agent' OR coalesce(json_extract(creator.payload_json,'$.source'),'')!='android_sdk')`;
const select = `SELECT n.id,n.sequence,n.kind,n.read_at,e.created_at,w.item_key,w.title,w.product_id,p.name AS product_name,
  e.comment_id,e.business_event_id,c.withdrawn_at,c.body_json,c.summary,coalesce(c.account_id,b.account_id) AS actor_id,c.agent_name,b.payload_json,${resolution} AS resolved_at ${joins}`;

export class PersonalNotifications {
  constructor(private store: MissionGoStore, private accounts: AccountStore) {}
  private get db() { return this.store.database.connection; }
  private productIds(account: AccountSnapshot) {
    return this.store.listProducts({includeArchived:true}).filter(p => this.accounts.allows(account,p.id,"view")).map(p=>p.id);
  }
  private scope(account: AccountSnapshot) {
    // Use the same capability check as item reads (including project administrators).
    const ids = this.productIds(account);
    return {sql:`n.account_id=? AND w.product_id IN (${ids.map(()=>"?").join(",") || "NULL"})`,args:[account.id,...ids]};
  }
  private filter(filter: PersonalNotificationFilter) {
    const sql:string[]=[visibleNotice],args:(string|number)[]=[];
    if(filter.unread) sql.push(needsReading);
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
    return {id:row.id,sequence:row.sequence,kind:row.kind,readAt:row.read_at,resolvedAt:row.resolved_at,createdAt:row.created_at,
      itemKey:row.item_key,itemTitle:row.title,productId:row.product_id,productName:row.product_name,
      actorName:row.agent_name || (row.actor_id ? this.accounts.displayNames([row.actor_id]).get(row.actor_id) : undefined) || "",
      summary:unavailable ? "" : (row.summary || text).slice(0,240),text,commentId:row.comment_id,businessEventId:row.business_event_id,unavailable};
  }
  count(account: AccountSnapshot) {
    const scope=this.scope(account);
    return (this.db.prepare(`SELECT count(*) AS count ${joins} WHERE ${scope.sql} AND ${needsReading}`).get(...scope.args) as {count:number}).count;
  }
  private todoScope(account: AccountSnapshot, productId?:string) {
    const ids=this.productIds(account).filter(id=>!productId || id===productId);
    return {sql:`${todoWhere} AND w.product_id IN (${ids.map(()=>"?").join(",") || "NULL"})`,args:[account.id,...ids]};
  }
  todos(account:AccountSnapshot, filter:{productId?:string|undefined;beforeSequence?:number|undefined}={}):PersonalTodoPage {
    const scope=this.todoScope(account,filter.productId);
    const rows=this.db.prepare(`SELECT w.id,w.rowid AS sequence,w.item_key,w.title,w.product_id,p.name AS product_name,
      (SELECT e.id FROM work_item_events e WHERE e.item_id=w.id AND e.history_source_key IS NULL
        AND e.event_type='status_changed' AND e.to_status='pending_verification' ORDER BY e.timeline_seq DESC LIMIT 1) AS business_event_id,
      coalesce((SELECT e.created_at FROM work_item_events e WHERE e.item_id=w.id AND e.history_source_key IS NULL
        AND e.event_type='status_changed' AND e.to_status='pending_verification' ORDER BY e.timeline_seq DESC LIMIT 1),w.updated_at) AS created_at
      ${todoJoins} WHERE ${scope.sql} AND w.rowid<? ORDER BY w.rowid DESC LIMIT 51`)
      .all(...scope.args,filter.beforeSequence ?? Number.MAX_SAFE_INTEGER) as unknown as {
        id:string;sequence:number;item_key:string;title:string;product_id:string;product_name:string;created_at:string;business_event_id:string|null;
      }[];
    const page=rows.slice(0,50);
    return {todos:page.map(row=>({id:`verification:${row.id}:${row.business_event_id ?? "legacy"}`,sequence:row.sequence,kind:"verification",
      itemKey:row.item_key,itemTitle:row.title,productId:row.product_id,productName:row.product_name,createdAt:row.created_at,businessEventId:row.business_event_id})),
      ...(rows.length>50?{nextBeforeSequence:page.at(-1)!.sequence}:{})};
  }
  attentionCount(account:AccountSnapshot):PersonalAttentionCount {
    const todo=this.todoScope(account),scope=this.scope(account);
    const todoCount=(this.db.prepare(`SELECT count(*) AS count ${todoJoins} WHERE ${todo.sql}`).get(...todo.args) as {count:number}).count;
    const unreadCount=this.count(account);
    // Ordinary delivery reminders are already hidden by visibleNotice, so the
    // old covered count is always zero; keep the field for older clients.
    // Per-project split for the inbox project filter (AND-493). Both reuse the
    // scopes above, so an inaccessible or archived product never appears.
    const todoByProduct=this.db.prepare(`SELECT w.product_id AS productId,count(*) AS count ${todoJoins}
      WHERE ${todo.sql} GROUP BY w.product_id`).all(...todo.args) as unknown as PersonalAttentionCount["todoByProduct"];
    const unreadByProduct=this.db.prepare(`SELECT w.product_id AS productId,count(*) AS count ${joins}
      WHERE ${scope.sql} AND ${needsReading} GROUP BY w.product_id`).all(...scope.args) as unknown as PersonalAttentionCount["unreadByProduct"];
    return {count:todoCount+unreadCount,todoCount,unreadCount,coveredUnreadCount:0,todoByProduct,unreadByProduct};
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
  app.get("/api/v1/attention/count",async request=>service.attentionCount(requireAccount(request)));
  app.get("/api/v1/attention/todos",async request=>service.todos(requireAccount(request),filter(request.query)));
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
