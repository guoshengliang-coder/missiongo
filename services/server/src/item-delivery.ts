import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountSnapshot, AccountStore } from "./accounts-store.js";
import type { MissionGoStore } from "./store.js";
import { conflict, invalidInput, notFound, MissionGoError } from "./errors.js";

interface Options { store: MissionGoStore; accounts: AccountStore; requireAccount: (request: FastifyRequest) => AccountSnapshot }
interface ExecutionRow {
  kind: "human" | "agent"; session_id: string | null;
  id: string; item_id: string; account_id: string; scope: string; previous_id: string | null;
  status: string; result: string; created_by: string; created_at: string; started_at: string | null; ended_at: string | null; updated_at: string;
}
function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw invalidInput("Request body is required.");
  return request.body as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw invalidInput(`${label} is required (max ${max}).`);
  return value.trim();
}

/** Cookie-only domain operations. Builder responsibility never bypasses product permissions. */
export function registerItemDeliveryRoutes(app: FastifyInstance, {store, accounts, requireAccount}: Options) {
  const db = store.database.connection;
  const visible = (request: FastifyRequest, productId: string) => {
    const account = requireAccount(request);
    if (!accounts.allows(account, productId, "view")) throw notFound("Product");
    return account;
  };
  const candidates = (productId: string) => accounts.listAccounts().filter(account => !account.disabledAt && accounts.allows(account, productId, "ai"));
  const name = (id: string) => accounts.displayNames([id]).get(id) ?? "已删除账号";
  const manages = (account: AccountSnapshot, item: ReturnType<MissionGoStore["getWorkItem"]>) =>
    !item.transferred && accounts.allows(account, item.productId, "operate") &&
    (account.role === "admin" || store.getProduct(item.productId).createdByAccountId === account.id || item.builderAccountId === account.id);
  const configuresBuilders = (account: AccountSnapshot, productId: string) => accounts.isProjectAdministrator(account,productId) ||
    accounts.allows(account,productId,"operate") && (account.role === "admin" || store.getProduct(productId).createdByAccountId === account.id);
  const managesBuilder = (account: AccountSnapshot, item: ReturnType<MissionGoStore["getWorkItem"]>) =>
    !item.transferred && (accounts.isProjectAdministrator(account,item.productId) || manages(account,item));
  const writable = (request: FastifyRequest, key: string, builderOnly = false) => {
    const item = store.getWorkItem(key);
    const account = visible(request, item.productId);
    if (!(builderOnly ? managesBuilder(account,item) : manages(account,item))) throw new MissionGoError("delivery_management_required", "当前账号没有此项交付管理权限。", 403);
    store.assertWorkItemWritable(key);
    return { item, account };
  };
  const list = (key: string) => {
    const item = store.getWorkItem(key);
    const humans = (db.prepare("SELECT * FROM item_executions WHERE item_id = ? ORDER BY rowid").all(item.id) as unknown as ExecutionRow[]).map(row => ({
      id: row.id, kind: row.kind, recorded: true, sessionStatus: row.session_id ? (db.prepare("SELECT status FROM agent_sessions WHERE id=? UNION ALL SELECT progress_status AS status FROM external_agent_sessions WHERE id=? LIMIT 1").get(row.session_id,row.session_id) as {status:string} | undefined)?.status : undefined, sessionId: row.session_id ?? undefined, accountId: row.account_id, accountName: name(row.account_id), name: row.kind === "agent" ? (db.prepare("SELECT agent_kind FROM agent_sessions WHERE id=? UNION ALL SELECT agent_kind FROM external_agent_sessions WHERE id=? LIMIT 1").get(row.session_id,row.session_id) as {agent_kind:string} | undefined)?.agent_kind ?? "Agent" : name(row.account_id), scope: row.scope,
      previousId: row.previous_id, status: row.status, result: row.result,
      createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at,
    }));
    // These existing sources are linked by item ID; we never infer ownership from agent names.
    const external = db.prepare(`SELECT s.id,s.account_id,s.agent_kind,s.progress_status AS status,s.created_at,s.updated_at
      FROM external_agent_sessions s JOIN external_agent_session_items i ON i.session_id=s.id WHERE i.item_id=?`).all(item.id) as unknown as Array<{id:string;account_id:string;agent_kind:string;status:string;created_at:string;updated_at:string}>;
    const dispatched = db.prepare(`SELECT s.id,d.account_id,s.agent_kind,s.status,s.created_at,s.updated_at
      FROM agent_sessions s JOIN dispatches d ON d.id=s.dispatch_id JOIN dispatch_items i ON i.dispatch_id=d.id WHERE i.item_id=?`).all(item.id) as unknown as typeof external;
    const agents = [...external, ...dispatched].filter(row => !humans.some(execution => execution.sessionId === row.id)).map(row => ({ id: `${row.id}:${item.id}`, kind: "agent", accountId: row.account_id,
      name: row.agent_kind, accountName: name(row.account_id), scope: "Agent 会话执行（具体工作范围见对应会话）", sessionId: row.id,
      status: row.status, result: "", previousId: null, createdAt: row.created_at, startedAt: row.created_at,
      endedAt: ["completed", "failed"].includes(row.status) ? row.updated_at : null }));
    return [...humans, ...agents].sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  };
  app.get("/api/v1/products/:productId/builders", async request => {
    const {productId} = request.params as {productId:string};
    const account = visible(request, productId);
    return { canConfigure: configuresBuilders(account,productId), builders: candidates(productId).map(account => ({id:account.id, name:name(account.id)})) };
  });
  app.put("/api/v1/products/:productId/components/:componentId/builder", async request => {
    const {productId,componentId} = request.params as {productId:string;componentId:string};
    const account = visible(request, productId);
    if (!configuresBuilders(account,productId)) throw new MissionGoError("product_ownership_required", "A product administrator is required.", 403);
    const component = store.listComponents(productId, {includeArchived:true}).find(row => row.id === componentId);
    if (!component || component.archivedAt) throw notFound("Component");
    const {accountId} = body(request);
    if (accountId !== null && (typeof accountId !== "string" || !candidates(productId).some(row => row.id === accountId))) throw invalidInput("Choose an active Builder with AI permission on this product.");
    db.prepare("UPDATE components SET default_builder_account_id=?,updated_at=? WHERE id=? AND product_id=?")
      .run(accountId as string | null, new Date().toISOString(), componentId, productId);
    return store.listComponents(productId).find(row => row.id === componentId);
  });
  app.get("/api/v1/items/:itemKey/delivery", async request => {
    const {itemKey} = request.params as {itemKey:string}; const item = store.getWorkItem(itemKey);
    const account = visible(request, item.productId);
    return { builderAccountId: item.builderAccountId ?? null, builderName: item.builderName ?? null,
      builderNeedsReassignment: item.builderNeedsReassignment ?? false, canManage: manages(account,item), canManageBuilder: managesBuilder(account,item), currentAccountId: account.id,
      candidates: candidates(item.productId).map(row => ({id:row.id,name:name(row.id)})),
      performers: accounts.listAccounts().filter(row => !row.disabledAt && accounts.allows(row,item.productId,"view"))
        .map(row => ({id:row.id,name:name(row.id)})), executions: list(itemKey) };
  });
  app.post("/api/v1/items/:itemKey/builder", async request => {
    const {itemKey} = request.params as {itemKey:string}; const {item,account} = writable(request,itemKey,true);
    const input = body(request); const note = text(input.note,"Handover note");
    const target = input.accountId;
    if (target !== null && (typeof target !== "string" || !candidates(item.productId).some(row => row.id === target))) throw invalidInput("Choose an active Builder with AI permission on this product.");
    return store.database.transaction(() => {
      // Compare with what the user saw: two simultaneous transfers must not silently overwrite each other.
      const current = store.getWorkItem(itemKey);
      if ((current.builderAccountId ?? null) !== input.expectedBuilderAccountId) throw conflict("builder_changed", "The Builder changed. Refresh before transferring.");
      db.prepare("UPDATE work_items SET builder_account_id=?,builder_assignment='manual',updated_at=? WHERE id=?")
        .run(target as string | null, new Date().toISOString(), item.id);
      store.recordDeliveryEvent(itemKey,account.id,"builder_changed",{from:current.builderAccountId ?? null,to:target,note,
        fromName:current.builderName ?? "待分配",toName:target ? name(target as string) : "待分配"});
      return store.getWorkItem(itemKey);
    });
  });
  app.post("/api/v1/items/:itemKey/executions", async (request,reply) => {
    const {itemKey} = request.params as {itemKey:string}; const {item,account} = writable(request,itemKey);
    const input = body(request); const scope = text(input.scope,"Execution scope");
    const kind = input.kind ?? "human";
    if (kind !== "human" && kind !== "agent") throw invalidInput("Unsupported performer type.");
    const agent = kind === "agent" ? list(itemKey).find(row => row.kind === "agent" && row.sessionId === input.sessionId) : undefined;
    if (kind === "agent" && !agent) throw notFound("Linked Agent session");
    const performer = accounts.listAccounts().find(row => row.id === (agent?.accountId ?? input.accountId) && !row.disabledAt && accounts.allows(row,item.productId,"view"));
    if (!performer) throw invalidInput("Choose an active account on this product.");
    const sessionId = agent && "sessionId" in agent ? agent.sessionId : null;
    const previousId = input.previousId == null ? null : text(input.previousId,"Previous execution",100);
    const note = previousId ? text(input.note,"Execution handover note") : "";
    const followUp = input.followUp === true;
    store.database.transaction(() => {
      const now = new Date().toISOString(); const id = randomUUID();
      if (previousId) {
        let previous = db.prepare("SELECT * FROM item_executions WHERE id=? AND item_id=?").get(previousId,item.id) as unknown as ExecutionRow | undefined;
        if (!previous) {
          const linked = list(itemKey).find(row => row.id === previousId && row.kind === "agent");
          if (!linked || !linked.sessionId) throw notFound("Execution");
          if (!followUp && ["completed","failed"].includes(linked.status)) throw conflict("execution_finished","This execution is already finished.");
          db.prepare(`INSERT INTO item_executions(id,item_id,account_id,scope,kind,session_id,status,created_by,created_at,started_at,ended_at,updated_at)
            VALUES (?,?,?,?,'agent',?,?,?,?,?,?,?)`).run(previousId,item.id,linked.accountId,linked.scope,linked.sessionId,
              ["completed","failed"].includes(linked.status) ? linked.status : "working",account.id,linked.createdAt,linked.startedAt,linked.endedAt,now);
          previous = db.prepare("SELECT * FROM item_executions WHERE id=?").get(previousId) as unknown as ExecutionRow;
        }
        const finished = ["completed","cancelled","handed_over","failed"].includes(previous.status);
        if (followUp && !finished) throw invalidInput("Use a handover for an unfinished execution.");
        if (!followUp && finished) throw conflict("execution_finished","This execution is already finished.");
        if (!followUp) db.prepare("UPDATE item_executions SET status='handed_over',result=?,ended_at=?,updated_at=? WHERE id=?")
          .run(note,now,now,previousId);
      }
      db.prepare(`INSERT INTO item_executions(id,item_id,account_id,scope,previous_id,kind,session_id,status,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'assigned',?,?,?)`).run(id,item.id,performer.id,scope,previousId,kind,sessionId ?? null,account.id,now,now);
      store.recordDeliveryEvent(itemKey,account.id,previousId ? followUp ? "execution_follow_up" : "execution_handed_over" : "execution_assigned",{executionId:id,previousId,performer:kind === "agent" ? `Agent · ${name(performer.id)}` : name(performer.id),scope,note});
    });
    return reply.status(201).send({executions:list(itemKey)});
  });
  app.patch("/api/v1/items/:itemKey/executions/:executionId", async request => {
    const {itemKey,executionId} = request.params as {itemKey:string;executionId:string};
    const item = store.getWorkItem(itemKey); const account = visible(request,item.productId); store.assertWorkItemWritable(itemKey);
    const input = body(request); const status = input.status;
    if (typeof status !== "string" || !["working","completed","blocked","cancelled"].includes(status)) throw invalidInput("Unsupported execution status.");
    const result = status === "working" ? "" : text(input.result,"Execution result");
    store.database.transaction(() => {
      const row = db.prepare("SELECT * FROM item_executions WHERE id=? AND item_id=?").get(executionId,item.id) as unknown as ExecutionRow | undefined;
      if (!row) throw notFound("Execution");
      if (!accounts.allows(account,item.productId,"operate") || (row.account_id !== account.id && !manages(account,item))) throw new MissionGoError("execution_owner_required","Only this performer or the delivery manager can update execution.",403);
      if (["completed","cancelled","handed_over"].includes(row.status)) throw conflict("execution_finished","This execution is already finished.");
      const now = new Date().toISOString();
      db.prepare("UPDATE item_executions SET status=?,result=?,started_at=?,ended_at=?,updated_at=? WHERE id=?")
        .run(status,result,row.started_at ?? (status === "working" ? now : null),["completed","cancelled"].includes(status) ? now : null,now,executionId);
      store.recordDeliveryEvent(itemKey,account.id,"execution_updated",{executionId,status,result});
    });
    return {executions:list(itemKey)};
  });
}
