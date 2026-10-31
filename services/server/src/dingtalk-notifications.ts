import { DingTalkCardStream } from "./dingtalk-card-stream.js";
import { cardText, limitCardText } from "./dingtalk-verification-card.js";
import { z } from "zod";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { DingTalkDeliveryMode, DingTalkSettings, DingTalkSettingsInput, DingTalkBinding, DingTalkBindingInput, DingTalkImportRow, DingTalkImportPreview, DingTalkNotification, DingTalkProjectSettings } from "@missiongo/domain";
import type { MissionGoStore } from "./store.js";
import type { MissionGoDatabase } from "./storage/database.js";
import type { AccountSnapshot, AccountStore } from "./accounts-store.js";
import { conflict, invalidInput, notFound, MissionGoError } from "./errors.js";
import { buildVerificationCard } from "./dingtalk-verification-card.js";

interface ConfigRow { corp_id: string; client_id: string; agent_id: string; delivery_mode: DingTalkDeliveryMode; robot_code: string; encrypted_secret: string; revision: number }
interface JobRow {
  id: string; event_id: string | null; item_id: string | null; account_id: string | null;
  kind: "verification" | "test" | "comment"; comment_id: string | null; status: DingTalkNotification["status"]; reason: string;
  attempts: number; task_id: string | null; recipient: string | null; config_revision: number | null;
  binding_revision: string | null;
  created_at: string; updated_at: string;
}
class ProviderError extends Error {
  constructor(readonly code: number | string) {
    const safeCode = /^[\w.-]{1,120}$/.test(String(code)) ? String(code) : "unknown";
    const guidance = safeCode === "robot.oto.notExist" ? "没有有效的机器人单聊会话，请在钉钉确认该成员可使用机器人，并尝试打开机器人会话。"
      : safeCode === "chatbotId.notAllow.sendOTO" ? "机器人尚未允许主动单聊，请在钉钉后台启用并发布机器人及应用。"
      : "请检查应用权限（机器人需企业内机器人发送消息权限）、凭据和接收人范围。";
    super(`钉钉接口返回错误（${safeCode}），${guidance}`);
  }
}
const now = () => new Date().toISOString();
const after = (ms: number) => new Date(Date.now() + ms).toISOString();
function text(value: unknown, label: string, max = 100, required = true): string {
  if (typeof value !== "string" || value.trim().length > max || required && !value.trim() || Array.from(value).some(char=>char.charCodeAt(0)<32)) throw invalidInput(`${label} 无效。`);
  return value.trim();
}
function identifier(value: unknown, label: string): string {
  const result = text(value,label);
  // DingTalk accepts comma-separated recipients. A binding must name exactly one.
  if (/[\s,;]/u.test(result)) throw invalidInput(`${label} 只能填写一个标识，不能包含空白、逗号或分号。`);
  return result;
}
/** Called inside the status transaction, never from HTTP hooks or a history scan. */
export function enqueueVerificationNotification(database: MissionGoDatabase, eventId: string, itemId: string, productId: string, accountId: string | undefined, at: string): void {
  const enabled = database.connection.prepare("SELECT enabled FROM dingtalk_projects WHERE product_id=?").get(productId) as {enabled:number} | undefined;
  database.connection.prepare(`INSERT INTO dingtalk_notifications
    (id,event_id,item_id,account_id,kind,status,reason,next_at,created_at,updated_at)
    VALUES (?,?,?,?,'verification',?,?,?,?,?)`).run(randomUUID(),eventId,itemId,accountId ?? null,
      enabled?.enabled ? "queued" : "skipped",enabled?.enabled ? "" : "项目未开启通知",at,at,at);
}

/** One-way work notices or robot DMs. Provider response bodies never enter logs. */
export class DingTalkNotifications {
  private readonly db;
  private readonly key: Buffer | undefined;
  private token: { value: string; expiresAt: number; revision: number } | undefined;
  private tokenRequest: {revision:number;promise:Promise<string>} | undefined;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private stream: { revision: number; client: DingTalkCardStream } | undefined;
  constructor(private readonly store: MissionGoStore, private readonly accounts: AccountStore, secret: string | undefined, private readonly origin: string | undefined, private readonly fetchImpl: typeof fetch = fetch, private readonly cardTemplateId?: string, private readonly cardTheme = "blue", private readonly commentCardTemplateId?: string) {
    this.db = store.database.connection;
    this.key = secret ? createHash("sha256").update("missiongo-dingtalk-v1\0").update(secret).digest() : undefined;
  }
  private config(): ConfigRow | undefined { return this.db.prepare("SELECT * FROM dingtalk_settings WHERE id=1").get() as unknown as ConfigRow | undefined; }
  settings(): DingTalkSettings {
    const row = this.config();
    return {corpId:row?.corp_id ?? "",clientId:row?.client_id ?? "",agentId:row?.agent_id ?? "",deliveryMode:row?.delivery_mode ?? "work_notice",robotCode:row?.robot_code ?? "",configured:Boolean(row && this.key),revision:row?.revision ?? 0};
  }
  private audit(actor: string, action: string, subject: string, details: unknown = {}) {
    this.db.prepare("INSERT INTO dingtalk_audit(id,actor_account_id,action,subject,details_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(),actor,action,subject,JSON.stringify(details),now());
  }
  saveSettings(input: DingTalkSettingsInput, actor: string): DingTalkSettings {
    if (!this.key) throw invalidInput("请先为服务器配置持久化会话密钥，再保存钉钉凭据。");
    const corpId=identifier(input.corpId,"组织 ID"),clientId=identifier(input.clientId,"Client ID");
    return this.store.database.transaction(() => {
      const previous=this.config();
      if (input.expectedRevision !== (previous?.revision ?? 0)) throw conflict("dingtalk_settings_changed","配置已被修改，请刷新后重试。");
      const deliveryMode=input.deliveryMode===undefined ? previous?.delivery_mode ?? "work_notice" : input.deliveryMode;
      if (deliveryMode!=="work_notice" && deliveryMode!=="robot") throw invalidInput("通知方式无效。");
      const agentId=text(input.agentId,"Agent ID",100,deliveryMode==="work_notice");
      if (agentId && !/^\d+$/.test(agentId)) throw invalidInput("Agent ID 必须为数字。");
      const robotCode=input.robotCode===undefined ? previous?.robot_code ?? "" : text(input.robotCode,"机器人编码",100,false);
      if (robotCode && !/^[A-Za-z0-9_-]+$/.test(robotCode)) throw invalidInput("机器人编码只能包含字母、数字、下划线和连字符，请勿填写 Webhook 地址。");
      if (deliveryMode==="robot" && !robotCode) throw invalidInput("机器人单聊通知需要填写 robotCode。");
      if (previous && previous.corp_id !== corpId && this.db.prepare("SELECT 1 FROM dingtalk_bindings LIMIT 1").get()) throw conflict("dingtalk_organization_bound","更换组织前，请先解除现有人员绑定。");
      let encrypted=previous?.encrypted_secret;
      if (input.clientSecret !== undefined) {
        const secret=text(input.clientSecret,"Client Secret",512);
        const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.key!,nonce);
        const ciphertext=Buffer.concat([cipher.update(secret,"utf8"),cipher.final()]);
        encrypted=Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString("base64");
      } else if (!previous || previous.corp_id !== corpId || previous.client_id !== clientId) throw invalidInput("首次配置或更换组织、应用时必须填写 Client Secret。");
      this.db.prepare(`INSERT INTO dingtalk_settings(id,corp_id,client_id,agent_id,delivery_mode,robot_code,encrypted_secret,revision,updated_at) VALUES(1,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET corp_id=excluded.corp_id,client_id=excluded.client_id,agent_id=excluded.agent_id,delivery_mode=excluded.delivery_mode,robot_code=excluded.robot_code,encrypted_secret=excluded.encrypted_secret,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(corpId,clientId,agentId,deliveryMode,robotCode,encrypted!, (previous?.revision ?? 0)+1,now());
      this.token=undefined; this.audit(actor,"configure","integration");
      return this.settings();
    });
  }
  bindings(): DingTalkBinding[] {
    return (this.db.prepare("SELECT account_id AS accountId,user_id AS userId,name,department,revision FROM dingtalk_bindings ORDER BY account_id").all() as unknown as DingTalkBinding[]);
  }
  private validateBinding(input: DingTalkBindingInput): DingTalkBindingInput {
    if (!input || typeof input!=="object" || Array.isArray(input)) throw invalidInput("绑定格式无效。");
    return {userId:identifier(input.userId,"钉钉企业用户 ID"),name:text(input.name,"姓名",100,false),department:text(input.department,"部门",200,false)};
  }
  saveBinding(accountId: string, input: DingTalkBindingInput | null, expectedRevision: string | null, actor: string): DingTalkBinding[] {
    return this.store.database.transaction(() => {
      this.accounts.getAccount(accountId);
      const existing=this.bindings().find(b=>b.accountId===accountId);
      if ((existing?.revision ?? null) !== expectedRevision) throw conflict("dingtalk_binding_changed","绑定已被修改，请刷新后重试。");
      if (input === null) {
        this.db.prepare("DELETE FROM dingtalk_bindings WHERE account_id=?").run(accountId);
        this.audit(actor,"unbind",accountId,{previous:existing});
      } else {
        const config=this.config(); if (!config) throw invalidInput("请先保存钉钉组织和应用配置。");
        const value=this.validateBinding(input);
        if (this.db.prepare("SELECT 1 FROM dingtalk_bindings WHERE corp_id=? AND user_id=? AND account_id<>?").get(config.corp_id,value.userId,accountId)) throw conflict("dingtalk_user_already_bound","该钉钉用户已绑定其他账号。");
        this.db.prepare(`INSERT INTO dingtalk_bindings(account_id,corp_id,user_id,name,department,revision,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(account_id) DO UPDATE SET corp_id=excluded.corp_id,user_id=excluded.user_id,name=excluded.name,department=excluded.department,revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(accountId,config.corp_id,value.userId,value.name,value.department,randomUUID(),now());
        this.audit(actor,"bind",accountId,{previous:existing,current:value});
      }
      return this.bindings();
    });
  }
  preview(rows: DingTalkImportRow[]): DingTalkImportPreview {
    if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw invalidInput("每次导入 1 至 500 行。");
    const accounts=this.accounts.listAccounts(),bindings=this.bindings(),seenEmails=new Set<string>(),seenUsers=new Set<string>();
    const result: DingTalkImportPreview["rows"] = rows.map(row=>{
      const email=text(row.email,"邮箱",254).toLowerCase(),value=this.validateBinding(row);
      const account=accounts.find(a=>a.email.toLowerCase()===email);
      let issue= !account ? "MissionGo 账号不存在" : account.disabledAt ? "账号已停用" : undefined;
      if (seenEmails.has(email)) issue="邮箱重复";
      if (seenUsers.has(value.userId)) issue="钉钉用户 ID 重复";
      const owner=bindings.find(b=>b.userId===value.userId);
      if (owner && owner.accountId !== account?.id) issue="钉钉用户已绑定其他账号";
      seenEmails.add(email);seenUsers.add(value.userId);
      return {email,...value,...(account?{accountId:account.id}:{}),...(issue?{issue}:{})};
    });
    return {rows:result,fingerprint:createHash("sha256").update(JSON.stringify({rows:result,bindings,revision:this.settings().revision})).digest("hex")};
  }
  importBindings(rows: DingTalkImportRow[], fingerprint: string, actor: string): DingTalkBinding[] {
    return this.store.database.transaction(()=>{
      const preview=this.preview(rows);
      if (preview.fingerprint !== fingerprint) throw conflict("dingtalk_import_changed","账号或绑定已变化，请重新预览导入。");
      if (preview.rows.some(row=>row.issue)) throw invalidInput("请先修正预览中的所有问题。");
      for (const row of preview.rows) this.saveBinding(row.accountId!,row,this.bindings().find(b=>b.accountId===row.accountId)?.revision ?? null,actor);
      return this.bindings();
    });
  }
  project(productId: string, account: AccountSnapshot): DingTalkProjectSettings {
    const product=this.store.getProduct(productId);
    if (!this.accounts.allows(account,productId,"view")) throw notFound("Product");
    const row=this.db.prepare("SELECT enabled FROM dingtalk_projects WHERE product_id=?").get(productId) as {enabled:number}|undefined;
    return {enabled:Boolean(row?.enabled),canConfigure:account.role==="admin" || this.accounts.isProjectAdministrator(account,productId) || product.createdByAccountId===account.id,integrationConfigured:this.settings().configured};
  }
  saveProject(productId: string, account: AccountSnapshot, enabled: boolean, expectedEnabled: boolean): DingTalkProjectSettings {
    return this.store.database.transaction(()=>{
      const current=this.project(productId,account);
      if (!current.canConfigure) throw new MissionGoError("dingtalk_configuration_required","需要项目管理权限。",403);
      if (current.enabled !== expectedEnabled) throw conflict("dingtalk_project_changed","项目通知开关已变化，请刷新后重试。");
      this.db.prepare("INSERT INTO dingtalk_projects(product_id,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(product_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at").run(productId,enabled?1:0,now());
      this.audit(account.id,"project_switch",productId,{enabled});return this.project(productId,account);
    });
  }
  private snapshot(row: JobRow): DingTalkNotification {
    const name = row.account_id ? this.accounts.displayNames([row.account_id]).get(row.account_id) : undefined;
    return {id:row.id,kind:row.kind,status:row.status,reason:row.reason,attempts:row.attempts,createdAt:row.created_at,updatedAt:row.updated_at,
      ...(row.comment_id ? {commentId:row.comment_id} : {}),...(name ? {accountName:name} : {}),
      canRetry:["failed","skipped","uncertain"].includes(row.status) && this.current(row)};
  }
  list(itemId: string): DingTalkNotification[] {
    return (this.db.prepare("SELECT * FROM dingtalk_notifications WHERE item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100").all(itemId) as unknown as JobRow[]).map(row=>this.snapshot(row));
  }
  tests(): Record<string,DingTalkNotification> {
    const rows=this.db.prepare(`SELECT n.* FROM dingtalk_notifications n JOIN dingtalk_bindings b ON b.account_id=n.account_id
      WHERE n.kind='test' AND n.binding_revision=b.revision AND n.config_revision=(SELECT revision FROM dingtalk_settings WHERE id=1)
      ORDER BY n.created_at,n.rowid`).all() as unknown as JobRow[];
    return Object.fromEntries(rows.filter(row=>row.account_id).map(row=>[row.account_id!,this.snapshot(row)]));
  }
  test(accountId: string, actor: string): DingTalkNotification {
    if (!this.settings().configured) throw invalidInput("请先配置钉钉应用。");
    if (!this.accounts.findActive(accountId) || !this.bindings().some(b=>b.accountId===accountId)) throw invalidInput("请选择已绑定、未停用的账号。");
    if (this.db.prepare("SELECT 1 FROM dingtalk_notifications WHERE kind='test' AND account_id=? AND (created_at>? OR status IN('queued','sending','accepted'))").get(accountId,after(-30_000))) throw new MissionGoError("dingtalk_test_limited","请等待上次测试完成，至少间隔 30 秒。",429);
    const id=randomUUID(),at=now();
    const binding=this.bindings().find(b=>b.accountId===accountId)!;
    this.db.prepare("INSERT INTO dingtalk_notifications(id,account_id,kind,status,next_at,created_at,updated_at,recipient,config_revision,binding_revision) VALUES(?,?,'test','queued',?,?,?,?,?,?)")
      .run(id,accountId,at,at,at,binding.userId,this.settings().revision,binding.revision);
    this.audit(actor,"test",accountId);return this.snapshot(this.job(id)!);
  }
  retry(itemKey: string, id: string, actor: string): void {
    const item=this.store.getWorkItem(itemKey),job=this.job(id);
    if (!job || job.item_id!==item.id) throw notFound("Notification");
    if (!["failed","skipped","uncertain"].includes(job.status) || !this.current(job)) throw conflict("dingtalk_retry_unavailable","只能补发仍有效且失败、跳过或结果不明的通知。");
    this.db.prepare("UPDATE dingtalk_notifications SET status='queued',reason='',task_id=NULL,next_at=?,updated_at=? WHERE id=?").run(now(),now(),id);
    this.audit(actor,"retry",id);
  }
  private job(id: string) { return this.db.prepare("SELECT * FROM dingtalk_notifications WHERE id=?").get(id) as unknown as JobRow | undefined; }
  private current(job: JobRow): boolean {
    if (job.kind==="test") return true;
    if (job.kind==="comment") {
      const row=this.db.prepare(`SELECT w.item_key FROM work_item_comments c JOIN work_items w ON w.id=c.item_id
        WHERE c.id=? AND c.item_id=? AND c.withdrawn_at IS NULL`).get(job.comment_id,job.item_id) as {item_key:string}|undefined;
      return Boolean(row && !this.store.getWorkItem(row.item_key).transferred);
    }
    const latest=this.db.prepare(`SELECT e.id,w.status FROM work_item_events e JOIN work_items w ON w.id=e.item_id
      WHERE e.item_id=? AND e.event_type='status_changed' AND e.to_status='pending_verification' AND e.history_source_key IS NULL ORDER BY e.timeline_seq DESC LIMIT 1`).get(job.item_id!) as {id:string;status:string}|undefined;
    return latest?.id===job.event_id && latest.status==="pending_verification";
  }
  private eligibility(job: JobRow): string | undefined {
    const recipientLabel=job.kind==="comment" ? "接收人" : "提需者";
    if (!job.account_id) return `未记录具体${recipientLabel}账号`;
    const account=this.accounts.findActive(job.account_id);if (!account) return `${recipientLabel}账号不存在或已停用`;
    if (job.item_id) {
      const item=this.db.prepare("SELECT product_id FROM work_items WHERE id=?").get(job.item_id) as {product_id:string}|undefined;
      if (!item || !this.accounts.allows(account,item.product_id,"view")) return `${recipientLabel}没有项目查看权限`;
      if (job.kind!=="comment" && !(this.db.prepare("SELECT enabled FROM dingtalk_projects WHERE product_id=?").get(item.product_id) as {enabled:number}|undefined)?.enabled) return "项目未开启通知";
      if (!this.current(job)) return job.kind==="comment" ? "评论已撤回或不可回复" : "条目已离开本轮待验证";
    }
    if (!this.settings().configured) return "钉钉应用未配置";
    if (!this.origin && job.kind!=="test") return "服务器未配置公开访问地址";
    if (!this.bindings().some(b=>b.accountId===job.account_id)) return `${recipientLabel}未绑定钉钉`;
    if (job.kind==="comment" && this.settings().deliveryMode!=="robot") return "评论提醒需要机器人单聊，请管理员配置机器人";
    if(job.kind==="test" && (job.binding_revision!==this.bindings().find(b=>b.accountId===job.account_id)?.revision || job.config_revision!==this.settings().revision)) return "绑定或应用配置已变化，请重新测试";
    return undefined;
  }
  private update(id: string, status: JobRow["status"], reason: string, delay = 0): void {
    this.db.prepare("UPDATE dingtalk_notifications SET status=?,reason=?,next_at=?,lease_until=NULL,updated_at=? WHERE id=?").run(status,reason,after(delay),now(),id);
  }
  private decrypt(config: ConfigRow): string {
    try {
      const bytes=Buffer.from(config.encrypted_secret,"base64"),decipher=createDecipheriv("aes-256-gcm",this.key!,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString("utf8");
    } catch { throw invalidInput("无法解密钉钉凭据，请管理员重新保存密钥。"); }
  }
  private async json(url: string, init?: RequestInit): Promise<Record<string,unknown>> {
    const response=await this.fetchImpl(url,{...init,redirect:"error",signal:AbortSignal.timeout(10_000)});
    const body=await response.json() as Record<string,unknown>;
    if (!response.ok) {
      if (response.status>=400 && response.status<500) throw new ProviderError(typeof body.errcode==="number" && body.errcode!==0 ? body.errcode : typeof body.code==="string" ? body.code : `HTTP_${response.status}`);
      throw new Error("钉钉服务暂时不可用");
    }
    if (typeof body.errcode==="number" && body.errcode!==0) throw new ProviderError(body.errcode);
    return body;
  }
  private async accessToken(config: ConfigRow): Promise<string> {
    if (this.token?.revision===config.revision && this.token.expiresAt>Date.now()) return this.token.value;
    if (!this.tokenRequest || this.tokenRequest.revision!==config.revision) {
      const url=new URL("https://oapi.dingtalk.com/gettoken");url.searchParams.set("appkey",config.client_id);url.searchParams.set("appsecret",this.decrypt(config));
      const request={revision:config.revision,promise:Promise.resolve("")};
      request.promise=this.json(url.href).then(body=>{
        if (typeof body.access_token!=="string" || typeof body.expires_in!=="number" || body.expires_in<=0) throw new Error("钉钉凭据响应无效");
        if(this.config()?.revision===config.revision)this.token={value:body.access_token,expiresAt:Date.now()+Math.max(0,body.expires_in-60)*1000,revision:config.revision};
        return body.access_token;
      }).finally(()=>{if(this.tokenRequest===request)this.tokenRequest=undefined;});
      this.tokenRequest=request;
    }
    const token=await this.tokenRequest.promise;
    if (this.config()?.revision!==config.revision) throw new Error("发送期间配置已变化");
    return token;
  }
  async checkConnection(): Promise<void> {
    const config=this.config();if(!config)throw invalidInput("请先保存钉钉配置。");
    try {await this.accessToken(config);} catch {throw invalidInput("应用凭据验证失败，请检查配置和网络。");}
  }
  private async api(path: string, token: string, body: unknown) {
    const url=new URL(`https://oapi.dingtalk.com/topapi/message/corpconversation/${path}`);url.searchParams.set("access_token",token);
    try { return await this.json(url.href,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); }
    catch(error) { if (error instanceof ProviderError && (typeof error.code==="number" && [40014,42001,40001,88].includes(error.code) || error.code==="HTTP_401")) this.token=undefined;throw error; }
  }
  private async robotApi(path: "batchSend" | "readStatus", token: string, body: Record<string, unknown>) {
    const url=new URL(`https://api.dingtalk.com/v1.0/robot/oToMessages/${path}`);
    const headers={"content-type":"application/json","x-acs-dingtalk-access-token":token};
    if(path==="readStatus") for(const [key,value] of Object.entries(body)) url.searchParams.set(key,String(value));
    try {return await this.json(url.href,path==="readStatus" ? {headers} : {method:"POST",headers,body:JSON.stringify(body)});}
    catch(error){if(error instanceof ProviderError && /token|HTTP_401/i.test(String(error.code)))this.token=undefined;throw error;}
  }
  private robotMessage(job: JobRow, message: Record<string, unknown>) {
    if(job.kind==="test") return {msgKey:"sampleText",msgParam:JSON.stringify({content:`这是一条机器人单聊测试通知。此账号仅发送系统通知，请到 MissionGo 处理，无需回复。\n测试编号：${job.id}`})};
    if (job.kind==="comment") {
      const card=message.action_card as {title:string;markdown:string;single_url:string};
      return {msgKey:"sampleActionCard",msgParam:JSON.stringify({title:card.title,text:card.markdown,singleTitle:"回条目回复",singleURL:card.single_url})};
    }
    const card=message.action_card as {title:string;markdown:string;single_title:string;single_url:string};
    return {msgKey:"sampleActionCard",msgParam:JSON.stringify({title:card.title,text:card.markdown+"\n\n此账号仅发送系统通知，请到 MissionGo 处理，无需回复。",singleTitle:card.single_title,singleURL:card.single_url})};
  }
  private async sendInteractiveCard(job: JobRow, token: string, robotCode: string, recipient: string): Promise<string> {
    const params=this.verificationCard(job);
    if(Buffer.byteLength(params.itemUrl,"utf8")>1000) throw new Error("card URL too long");
    const body=await this.json("https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",{method:"POST",headers:{"content-type":"application/json","x-acs-dingtalk-access-token":token},body:JSON.stringify({cardTemplateId:this.cardTemplateId,outTrackId:job.id,cardData:{cardParamMap:params},openSpaceId:`dtv1.card//IM_ROBOT.${recipient}`,imRobotOpenSpaceModel:{supportForward:false},imRobotOpenDeliverModel:{spaceType:"IM_ROBOT",robotCode}})});
    const result=body.result as {outTrackId?:unknown;deliverResults?:Array<{spaceType?:unknown;spaceId?:unknown;success?:unknown;carrierId?:unknown}>}|undefined;
    const delivery=result?.deliverResults?.find(value=>value.spaceType==="IM_ROBOT" && value.spaceId===recipient);
    if(body.success!==true || result?.outTrackId!==job.id || !delivery || delivery.success!==true || typeof delivery.carrierId!=="string" || !delivery.carrierId.trim()) throw new Error("card delivery result unclear");
    return delivery.carrierId;
  }
  private verificationCard(job: JobRow) {
    const item=this.db.prepare("SELECT item_key,title,description,product_id FROM work_items WHERE id=?").get(job.item_id!) as {item_key:string;title:string;description:string;product_id:string};
    const event=this.db.prepare("SELECT payload_json FROM work_item_events WHERE id=?").get(job.event_id!) as {payload_json:string};
    const url=new URL(this.origin!);url.searchParams.set("product",item.product_id);url.searchParams.set("item",item.item_key);
    return buildVerificationCard({projectName:this.store.getProduct(item.product_id).name,itemKey:item.item_key,itemTitle:item.title,description:item.description,itemUrl:url.href,payload:JSON.parse(event.payload_json) as Record<string,unknown>},this.cardTheme);
  }
  private commentCard(job: JobRow): Record<string,string> {
    const row=this.db.prepare(`SELECT c.body_kind,c.body_json,c.agent_name,c.account_id,c.actor_kind,c.reply_to_comment_id,w.item_key,w.title,w.product_id
      FROM work_item_comments c JOIN work_items w ON w.id=c.item_id WHERE c.id=?`).get(job.comment_id!) as {
        body_kind:string;body_json:string;agent_name:string|null;account_id:string|null;actor_kind:string;reply_to_comment_id:string|null;item_key:string;title:string;product_id:string};
    const body=JSON.parse(row.body_json) as Record<string,unknown>;
    const content=row.body_kind==="free" ? String(body.text ?? "") : [body.understanding,body.finding,body.proposal,...(Array.isArray(body.evidence)?body.evidence:[]),...(Array.isArray(body.openQuestions)?body.openQuestions:[])].filter(Boolean).join("\n\n");
    const accountName=row.account_id ? this.accounts.displayNames([row.account_id]).get(row.account_id) : undefined;
    const author=row.actor_kind==="agent" ? `${row.agent_name ?? "Agent"}${accountName ? `（${accountName}授权）` : ""}` : accountName ?? "用户";
    const url=new URL(this.origin!);url.searchParams.set("product",row.product_id);url.searchParams.set("item",row.item_key);url.searchParams.set("comment",job.comment_id!);
    const parent=row.reply_to_comment_id ? this.store.listComments(row.item_key).find(c=>c.id===row.reply_to_comment_id) : undefined;
    const parentBody=parent?.body as unknown as Record<string,unknown> | undefined;
    const parentText=parentBody ? String(parentBody.text ?? parentBody.finding ?? "") : "";
    return {headerTitle:limitCardText(`${row.item_key} ｜ 评论提醒`),itemTitle:limitCardText(cardText(row.title)),author:limitCardText(cardText(author)),
      commentText:limitCardText(content || "（评论含附件，请回条目查看）",950),parentText:limitCardText(cardText(parentText),700),
      contentHint:Buffer.byteLength(content,"utf8")>950 ? "评论较长，已截断；请打开条目查看全文。" : "",
      itemUrl:url.href,replyStatus:"",replySaved:"false"};
  }

  /** Only called for authenticated card frames on this application's Stream connection. */
  receiveCommentCard(raw: unknown): Record<string,unknown> {
    const envelope=z.object({outTrackId:z.string().uuid(),corpId:z.string().min(1),userId:z.string().min(1),userIdType:z.literal(1),
      content:z.string().max(80_000).optional(),value:z.string().max(80_000).optional()}).safeParse(raw);
    if (!envelope.success) throw invalidInput("卡片回复格式无效。");
    const input=envelope.data,job=this.job(input.outTrackId),config=this.config();
    if (!config || input.corpId!==config.corp_id || !job || job.kind!=="comment" || !job.account_id || !job.comment_id
      || !["sent","accepted","sending","uncertain"].includes(job.status) || job.config_revision!==config.revision) throw invalidInput("此卡片已失效，请回条目回复。");
    const binding=this.bindings().find(b=>b.accountId===job.account_id),account=this.accounts.findActive(job.account_id);
    if (!binding || binding.userId!==input.userId || job.recipient!==input.userId || binding.revision!==job.binding_revision || !account) throw invalidInput("回复者账号绑定已变化，请回条目回复。");
    const itemRow=this.db.prepare("SELECT item_key FROM work_items WHERE id=?").get(job.item_id!) as {item_key:string}|undefined;
    if (!itemRow) throw invalidInput("条目不存在。");
    const item=this.store.getWorkItem(itemRow.item_key);
    if (item.transferred || !this.accounts.allows(account,item.productId,"view") || !this.accounts.allows(account,item.productId,"operate")) throw invalidInput("没有本项目评论权限，请回条目查看。");
    let value:unknown;
    try { value=JSON.parse(input.content ?? input.value ?? "{}"); } catch { throw invalidInput("卡片回复内容无效。"); }
    const action=z.object({cardPrivateData:z.object({actionIds:z.array(z.string()).max(10),params:z.object({action:z.literal("reply"),replyText:z.string().trim().min(1).max(20_000)})})}).safeParse(value);
    if (!action.success) throw invalidInput("请输入回复内容后发送。");
    const reply=action.data.cardPrivateData.params.replyText;
    // One successful submission per recipient card. A retransmitted callback returns the same result.
    const comment=this.store.createComment({itemKey:item.key,actorKind:"human",bodyKind:"free",body:{text:reply},replyToCommentId:job.comment_id,
      attribution:{accountId:account.id},idempotencyKey:`dingtalk-card-reply:${job.id}`});
    const savedText=(comment.body as {text:string}).text;
    return {cardUpdateOptions:{updateCardDataByKey:true},cardData:{cardParamMap:{replyStatus:savedText===reply ? "回复成功，已同步到条目。" : "此卡片已提交过回复，请回条目继续回复。",replySaved:"true"}}};
  }

  private ensureCardStream(): void {
    const config=this.config();
    const eligible=Boolean(config && this.key && config.delivery_mode==="robot" && this.commentCardTemplateId);
    if (this.stream && (!eligible || this.stream.revision!==config?.revision)) {this.stream.client.close();this.stream=undefined;}
    if (!this.stream && eligible && config) {
      const client=new DingTalkCardStream(config.client_id,this.decrypt(config),raw=>this.receiveCommentCard(raw));
      this.stream={revision:config.revision,client};client.start();
    }
  }

  private message(job: JobRow): Record<string,unknown> {
    if (job.kind==="comment") {
      const card=this.commentCard(job);
      return {msgtype:"action_card",action_card:{title:card.headerTitle,markdown:[card.itemTitle,`评论者：${card.author}`,card.parentText ? `回复内容：${card.parentText}` : "",cardText(card.commentText!),card.contentHint].filter(Boolean).join("\n\n"),single_url:card.itemUrl,single_title:"回条目回复"}};
    }
    if (job.kind==="test") return {msgtype:"text",text:{content:`这是一条账号绑定测试通知。收到后无需回复。\n测试编号：${job.id}`}};
    const card=this.verificationCard(job);
    const lines=[`### ${card.headerTitle}`,card.heading.replace(/<[^>]*>/g,""),...(card.summary?[card.summary]:[]),"---","**验收方式**",card.verification.replace(/\n/g,"\n\n")];
    return {msgtype:"action_card",action_card:{title:card.headerTitle,markdown:lines.join("\n\n"),single_title:"查看条目并验收",single_url:card.itemUrl}};
  }
  private async send(job: JobRow): Promise<void> {
    const claimed=this.db.prepare(`UPDATE dingtalk_notifications SET status='sending',attempts=attempts+1,lease_until=?,updated_at=?
      WHERE id=? AND status='queued'`).run(after(60_000),now(),job.id);
    if(!claimed.changes)return;
    job=this.job(job.id)!;
    const reason=this.eligibility(job);if(reason){this.update(job.id,"skipped",reason);return;}
    const config=this.config()!;
    let token: string;
    try {token=await this.accessToken(config);} catch {this.fail(job,"无法获取应用访问凭证，请检查配置或稍后重试。");return;}
    // All network waits finish before the last permission / binding check.
    const changed=this.eligibility(job);if(changed){this.update(job.id,"skipped",changed);return;}
    if (this.config()?.revision!==config.revision) {this.fail(job,"应用配置已变化，请重试。");return;}
    const binding=this.bindings().find(b=>b.accountId===job.account_id)!;
    const message=this.message(job);
    this.db.prepare("UPDATE dingtalk_notifications SET recipient=?,config_revision=?,binding_revision=? WHERE id=?").run(binding.userId,config.revision,binding.revision,job.id);
    try {
      let taskId: string;
      if(config.delivery_mode==="robot") {
        if (job.kind==="comment" && this.commentCardTemplateId) {
          const params=this.commentCard(job);
          if(Buffer.byteLength(params.itemUrl!,"utf8")>1000) throw new Error("card URL too long");
          const result=await this.json("https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",{method:"POST",headers:{"content-type":"application/json","x-acs-dingtalk-access-token":token},body:JSON.stringify({
            cardTemplateId:this.commentCardTemplateId,outTrackId:job.id,userIdType:1,callbackType:"STREAM",cardData:{cardParamMap:params},openSpaceId:`dtv1.card//IM_ROBOT.${binding.userId}`,
            imRobotOpenSpaceModel:{supportForward:false},imRobotOpenDeliverModel:{spaceType:"IM_ROBOT",robotCode:config.robot_code}})});
          const body=result.result as {outTrackId?:unknown;deliverResults?:Array<{spaceType?:unknown;spaceId?:unknown;success?:unknown;carrierId?:unknown}>}|undefined;
          const delivery=body?.deliverResults?.find(value=>value.spaceType==="IM_ROBOT" && value.spaceId===binding.userId);
          if(result.success!==true || body?.outTrackId!==job.id || delivery?.success!==true || typeof delivery.carrierId!=="string" || !delivery.carrierId.trim()) throw new Error("card delivery unclear");
          this.update(job.id,"sent","钉钉确认卡片投放成功；不代表已读或已回复。");return;
        } else if (job.kind==="verification" && this.cardTemplateId) {
          taskId=await this.sendInteractiveCard(job,token,config.robot_code,binding.userId);
        } else {
        const body=await this.robotApi("batchSend",token,{robotCode:config.robot_code,userIds:[binding.userId],...this.robotMessage(job,message)});
        const invalid=body.invalidStaffIdList,limited=body.flowControlledStaffIdList;
        if([invalid,limited].some(value=>Array.isArray(value)&&value.includes(binding.userId))) {
          this.fail(job,"机器人未发送成功，请检查企业 userId、应用可使用范围或发送频率。");return;
        }
        if(typeof body.processQueryKey!=="string" || !body.processQueryKey.trim())throw new Error("missing robot task");
        taskId=body.processQueryKey;
        }
      } else {
        const body=await this.api("asyncsend_v2",token,{agent_id:config.agent_id,userid_list:binding.userId,to_all_user:false,msg:message});
        if (typeof body.task_id!=="number" && typeof body.task_id!=="string") throw new Error("missing task");
        taskId=String(body.task_id);
      }
      this.db.prepare("UPDATE dingtalk_notifications SET status='accepted',task_id=?,reason='钉钉已受理，等待发送结果',next_at=?,lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND attempts=?").run(taskId,after(2000),now(),job.id,job.attempts);
    } catch(error) {
      if(error instanceof ProviderError) this.fail(job,error.message);
      else this.db.prepare("UPDATE dingtalk_notifications SET status='uncertain',reason='发送结果不明，请先核实接收情况再手动补发，以免重复通知。',lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND attempts=?").run(now(),job.id,job.attempts);
    }
  }
  private fail(job: JobRow, reason: string): void {
    const attempts=job.attempts;
    this.db.prepare("UPDATE dingtalk_notifications SET status=?,reason=?,task_id=NULL,next_at=?,lease_until=NULL,updated_at=? WHERE id=? AND attempts=? AND status IN('sending','accepted')")
      .run(attempts<3?"queued":"failed",reason,after(30_000*attempts),now(),job.id,attempts);
  }
  private async poll(job: JobRow): Promise<void> {
    const config=this.config();
    if (!config || config.revision!==job.config_revision) {this.update(job.id,"uncertain","应用配置已变化，无法核实此前发送结果。");return;}
    if (Date.now()-Date.parse(job.updated_at)>23*60*60_000) {this.update(job.id,"uncertain","发送结果查询已超时，请人工核实接收情况。");return;}
    // Claim a poll lease too, so overlapping server processes do not race updates.
    const lock=this.db.prepare("UPDATE dingtalk_notifications SET lease_until=? WHERE id=? AND status='accepted' AND (lease_until IS NULL OR lease_until<?)").run(after(60_000),job.id,now());
    if(!lock.changes)return;
    try {
      const token=await this.accessToken(config);
      if(config.delivery_mode==="robot") {
        const body=await this.robotApi("readStatus",token,{robotCode:config.robot_code,processQueryKey:job.task_id});
        const recipient=Array.isArray(body.messageReadInfoList) && body.messageReadInfoList.some(value=>value && typeof value==="object" && (value as {userId?:unknown}).userId===job.recipient && ["READ","UNREAD"].includes(String((value as {readStatus?:unknown}).readStatus)));
        if(body.sendStatus==="SUCCESS" && recipient) this.update(job.id,"sent","钉钉确认机器人单聊发送成功；不代表验收通过。");
        else if(body.sendStatus==="RECALLED") this.update(job.id,"skipped","机器人消息已撤回，未自动重新发送。");
        else this.db.prepare("UPDATE dingtalk_notifications SET next_at=?,lease_until=NULL WHERE id=?").run(after(15_000),job.id);
        return;
      }
      const body=await this.api("getsendresult",token,{agent_id:config.agent_id,task_id:job.task_id});
      const result=body.send_result as Record<string,unknown>|undefined;
      const has=(key:string)=>Array.isArray(result?.[key]) && (result![key] as unknown[]).includes(job.recipient);
      const forbidden=Array.isArray(result?.forbidden_list) && result.forbidden_list.some(value=>value && typeof value==="object" && (value as {userid?:unknown}).userid===job.recipient);
      if (has("failed_user_id_list") || has("invalid_user_id_list") || has("forbidden_user_id_list") || forbidden) this.fail(job,"钉钉未发送成功，请检查用户 ID、应用可使用范围或发送频率。");
      else if(has("read_user_id_list") || has("unread_user_id_list")) this.update(job.id,"sent","钉钉确认发送成功；不代表已读或验收通过。");
      else this.db.prepare("UPDATE dingtalk_notifications SET next_at=?,lease_until=NULL WHERE id=?").run(after(15_000),job.id);
    } catch { this.db.prepare("UPDATE dingtalk_notifications SET next_at=?,lease_until=NULL WHERE id=?").run(after(30_000),job.id); }
  }
  drain(): Promise<void> {
    if (this.running) return this.running;
    this.running=this.process().finally(()=>{this.running=undefined;});return this.running;
  }
  private async process(): Promise<void> {
    this.db.prepare("UPDATE dingtalk_notifications SET status='uncertain',reason='发送进程中断，结果不明，请人工核实后补发。',lease_until=NULL,updated_at=? WHERE status='sending' AND lease_until<?").run(now(),now());
    const jobs=this.db.prepare("SELECT * FROM dingtalk_notifications WHERE status IN('queued','accepted') AND next_at<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY next_at LIMIT 20").all(now(),now()) as unknown as JobRow[];
    for(const job of jobs){if(this.closed)break;try{if(job.status==="accepted")await this.poll(job);else await this.send(job);}catch{this.update(job.id,"failed","通知处理失败，请检查配置后重试。");}}
  }
  start(): void {
    const tick=()=>{try{this.ensureCardStream();}catch{/* Configuration errors are shown by notification eligibility. */}void this.drain().catch(()=>{});};
    this.timer=setInterval(tick,2000);this.timer.unref();tick();
  }
  async close(): Promise<void> {this.closed=true;this.stream?.client.close();this.stream=undefined;if(this.timer)clearInterval(this.timer);await this.running;}
}
