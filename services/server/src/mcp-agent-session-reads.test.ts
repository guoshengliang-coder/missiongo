import { AgentHistory } from "./agent-history.js";
import { AgentArtifacts } from "./agent-artifacts.js";
import { createHash, randomUUID, scryptSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { createAiAccessToken, type AdminAccountConfig } from "./admin-auth.js";
import { buildApp } from "./app.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { ExternalAgentSessionStore } from "./external-agent-session-store.js";
import { ExternalNativeSessionStore } from "./external-native-session-store.js";
import { ImplementationPlans, planDigest } from "./implementation-plans.js";
import { McpAgentSessionReads } from "./mcp-agent-session-reads.js";
import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
const apps: FastifyInstance[] = [];
const directories: string[] = [];
const owner = { accountId: "owner", clientId: "client" };

afterEach(async () => {
  vi.useRealTimers();
  stores.splice(0).forEach((store) => store.close());
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime("2026-11-05T04:00:00Z");
  const directory = await mkdtemp(join(tmpdir(), "missiongo-session-reads-"));
  directories.push(directory);
  const store = new MissionGoStore(":memory:");
  stores.push(store);
  const db = store.database.connection;
  const product = store.createProduct({ name: "Example", keyPrefix: "EX" });
  const item = store.createWorkItem({ productId: product.id, title: "Handle", description: "Work", type: "task", priority: "normal", environment: { platform: "web" } });
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "claim" });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node','owner','installation','Example node','synthetic','[{"kind":"codex"}]',?,?,?)`).run(now, now, now);
  const dispatch = new AgentSessionStore(store.database);
  const external = new ExternalAgentSessionStore(store);
  const native = new ExternalNativeSessionStore(store);
  const reads = new McpAgentSessionReads(store, join(directory, "attachments"));

  const createDispatchSession = (id: string, ref: string) => {
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,unread_at)
      VALUES (?, 'owner', 'node', 'codex', 'default', 'launched', '/synthetic/repo', ?, ?)`).run(id, now, now);
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run(id, item.id);
    return dispatch.createForDispatch({ dispatchId: id, nodeId: "node", sessionRef: ref });
  };
  const dispatchMessage = (sessionId: string, sourceId: string, role: "user" | "agent" | "plan", text: string, occurredAt: string, questions?: unknown) =>
    db.prepare(`INSERT INTO agent_session_messages(id,session_id,source_id,role,text,questions_json,position,observed_at,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), sessionId, sourceId, role, text, questions === undefined ? null : JSON.stringify(questions), 0, occurredAt, occurredAt);

  return { store, db, product, item, now, dispatch, external, native, reads, createDispatchSession, dispatchMessage };
}

it("lists dispatch, native and tracking conversations linked to the item with availability and rounds", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  f.dispatchMessage(dispatchSession, "user-1", "user", "Fix the handle", "2026-11-05T03:30:00Z");
  f.external.register(owner, { agentKind: "codex", sessionRef: "native-thread", refKind: "native" }, f.item.key);
  f.external.register(owner, { agentKind: "claude_code", sessionRef: "tracking-thread", refKind: "tracking" }, f.item.key);

  const conversations = f.reads.listConversations("owner", f.item.key);
  expect(conversations).toHaveLength(2);
  const sources = conversations.flatMap((conversation) => conversation.records.map((record) => [record.source, record.contentAvailability] as const));
  expect(sources).toContainEqual(["dispatch", "synced"]);
  expect(sources).toContainEqual(["external", "progress_only"]);
  const dispatchConversation = conversations.find((conversation) => conversation.records.some((record) => record.source === "dispatch"))!;
  expect(dispatchConversation.records.find((record) => record.source === "dispatch")!.round).toBe(1);
  expect(dispatchConversation.items).toEqual([{ key: f.item.key, title: "Handle", productId: f.product.id }]);
});

it("numbers a re-dispatched conversation as a second round", async () => {
  const f = await fixture();
  const first = f.createDispatchSession("dispatch", "thread-1");
  vi.setSystemTime("2026-11-05T04:05:00Z");
  f.db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,unread_at)
    VALUES ('dispatch-2','owner','node','codex','default','launched','/synthetic/repo',?,?)`).run(new Date().toISOString(), new Date().toISOString());
  f.db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run("dispatch-2", f.item.id);
  const second = f.dispatch.createForDispatch({ dispatchId: "dispatch-2", nodeId: "node", sessionRef: "thread-2" });
  const rounds = f.reads.listConversations("owner", f.item.key)
    .map((conversation) => conversation.records.map((record) => [record.dispatchId, record.round]));
  expect(rounds).toEqual(expect.arrayContaining([[["dispatch", 1]], [["dispatch-2", 2]]]));
  expect(first).not.toBe(second);
});

it("merges mirror transcripts, deduplicates native copies and keeps order, questions and progress reports", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  f.dispatchMessage(dispatchSession, "user-1", "user", "继续核查", "2026-11-05T03:10:00Z");
  f.dispatchMessage(dispatchSession, "agent-1", "agent", "已复现问题", "2026-11-05T03:20:00Z");
  f.dispatchMessage(dispatchSession, "plan-1", "plan", "方案：迁移加列", "2026-11-05T03:25:00Z");

  const externalId = f.external.register(owner, { agentKind: "codex", sessionRef: "native-thread", refKind: "native" }, f.item.key);
  // The dispatch session already mirrors this native thread on the same node, so
  // connect() would refuse; bind directly the way a node binding is recorded.
  f.db.prepare("UPDATE external_agent_sessions SET native_node_id='node', native_generation=1 WHERE id=?").run(externalId);
  f.native.recordSnapshot({
    accountId: "owner", nodeId: "node", sessionId: externalId, generation: 1, workerId: "worker-one",
    status: "idle", turnState: {},
    messages: [
      { sourceId: "user-1", role: "user", text: "继续核查（原生镜像）", occurredAt: "2026-11-05T03:10:00Z" },
      { sourceId: "agent-1", role: "agent", text: "已复现问题（原生镜像）", occurredAt: "2026-11-05T03:20:00Z" },
      { sourceId: "question-1", role: "agent", text: "选择回填方式", occurredAt: "2026-11-05T03:22:00Z",
        questions: [{ title: "回填方式", options: ["在线迁移", "停机迁移"] }] },
    ],
  }, () => {});
  f.external.report(owner, externalId, f.item.key, "working", "Local reproduction finished", "report-1");

  const result = f.reads.readConversation("owner", dispatchSession, { itemKey: f.item.key });
  // Registering the external record itself files an opening progress report.
  expect(result.messages.map((message) => message.sourceId)).toEqual(["user-1", "agent-1", "question-1", "plan-1", undefined, undefined]);
  // The dispatch mirror won because it was the requested record; the native copy deduplicated.
  expect(result.messages[0]!.recordSource).toBe("dispatch_sync");
  expect(result.messages[2]!.questions).toEqual([{ title: "回填方式", options: ["在线迁移", "停机迁移"] }]);
  const report = result.messages.at(-1)!;
  expect(report).toMatchObject({ recordSource: "progress_report", progressStatus: "working", text: "Local reproduction finished", progressItemKey: f.item.key });
  expect(result.completeness.contentAvailability).toBe("synced");
  expect(result.completeness.messageCount).toBe(6);
  expect(result.attachments).toEqual([]);
});

it("pages with a stable digest and requires a restart when messages arrive mid-read", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  for (let index = 1; index <= 3; index++) {
    f.dispatchMessage(dispatchSession, `m-${index}`, "agent", `Message ${index}`, `2026-11-05T03:0${index}:00Z`);
  }
  const firstPage = f.reads.readConversation("owner", dispatchSession, { itemKey: f.item.key, offset: 0, limit: 2 });
  expect(firstPage.messages.map((message) => message.text)).toEqual(["Message 1", "Message 2"]);
  expect(firstPage.nextOffset).toBe(2);
  const secondPage = f.reads.readConversation("owner", dispatchSession, { itemKey: f.item.key, offset: 2, limit: 2 });
  expect(secondPage.messages.map((message) => message.text)).toEqual(["Message 3"]);
  expect(secondPage.nextOffset).toBeUndefined();
  expect(secondPage.completeness.consistencyDigest).toBe(firstPage.completeness.consistencyDigest);
  f.dispatchMessage(dispatchSession, "m-4", "agent", "Message 4", "2026-11-05T03:04:00Z");
  const afterAppend = f.reads.readConversation("owner", dispatchSession, { itemKey: f.item.key, offset: 0, limit: 2 });
  expect(afterAppend.completeness.consistencyDigest).not.toBe(firstPage.completeness.consistencyDigest);
  f.db.prepare("UPDATE agent_session_messages SET text='Updated same ID' WHERE session_id=? AND source_id='m-1'").run(dispatchSession);
  const afterEdit=f.reads.readConversation("owner",dispatchSession,{itemKey:f.item.key});
  expect(afterEdit.completeness.consistencyDigest).not.toBe(afterAppend.completeness.consistencyDigest);

});

it("requires the linked item key, except for explicitly specified project conversations", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  expect(() => f.reads.readConversation("owner", dispatchSession)).toThrow(/explicitly specified project conversations/);

  // An unrelated item key must not unlock the conversation.
  const other = f.store.createWorkItem({ productId: f.product.id, title: "Other", description: "Work", type: "task", priority: "normal", environment: { platform: "web" } });
  expect(() => f.reads.readConversation("owner", dispatchSession, { itemKey: other.key })).toThrow(/not found/i);

  f.db.prepare(`INSERT INTO free_session_starts(dispatch_id,account_id,request_key,product_id,initial_text,config_json,ready)
    VALUES ('dispatch','owner','request-1',?, '项目会话','{}',1)`).run(f.product.id);
  const project = f.reads.readConversation("owner", dispatchSession);
  expect(project.source).toBe("project");
  expect(project.records.map((record) => record.source)).toContain("project");
});

it("reports offline nodes, archived conversations and progress-only records as known gaps", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  const trackingId = f.external.register(owner, { agentKind: "claude_code", sessionRef: "tracking-thread", refKind: "tracking" }, f.item.key);

  vi.setSystemTime("2026-11-05T05:00:00Z"); // node silent for an hour
  const conversations = f.reads.listConversations("owner", f.item.key);
  const dispatchRecord = conversations.flatMap((c) => c.records).find((record) => record.source === "dispatch")!;
  expect(dispatchRecord.knownGaps.some((gap) => gap.includes("offline"))).toBe(true);
  const trackingRecord = conversations.flatMap((c) => c.records).find((record) => record.id === trackingId)!;
  expect(trackingRecord.contentAvailability).toBe("progress_only");
  expect(trackingRecord.knownGaps.some((gap) => gap.includes("tracking only"))).toBe(true);

  f.db.prepare("UPDATE agent_sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), dispatchSession);
  const archived = f.reads.readConversation("owner", dispatchSession, { itemKey: f.item.key });
  expect(archived.completeness.knownGaps.some((gap) => gap.includes("archived"))).toBe(true);
});

it("returns plan references, separates tool-permission approval and never claims a formal record", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  f.dispatchMessage(dispatchSession, "user-1", "user", "请修复", "2026-11-05T03:10:00Z");
  f.dispatchMessage(dispatchSession, "plan-1", "plan", "方案：新增只读工具", "2026-11-05T03:20:00Z");

  const infos = f.reads.planApprovalInfos("owner", f.item.key);
  expect(infos).toHaveLength(1);
  const info = infos[0]!;
  expect(info.latestPlan).toMatchObject({ sourceId: "plan-1" });
  expect(info.latestPlan!.digest).toBe(createHash("sha256").update("方案：新增只读工具").digest("hex"));
  expect(info.formalRecords.available).toBe(false);
  expect(info.assessment.code).toBe("not_approval");
  expect(info.toolPermissionApproval).toBeUndefined();

  // A pending Codex permission request is attention-worthy, but it is a tool
  // permission, never a plan approval.
  f.db.prepare(`INSERT INTO agent_session_approvals(session_id,approval_id,kind,status,turn_id,action,started_at_ms,updated_at)
    VALUES (?,'approval-1','manual','pending','turn-1','Bash(rm -rf)',0,?)`).run(dispatchSession, f.now);
  const withPermission = f.reads.planApprovalInfos("owner", f.item.key)[0]!;
  expect(withPermission.assessment.code).toBe("permission_required");
  expect(withPermission.toolPermissionApproval).toMatchObject({ kind: "manual", status: "pending", action: "Bash(rm -rf)" });
  expect(withPermission.formalRecords.available).toBe(false);
});

it("exposes session attachments with their command context and reads the stored file", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  const attachments = await import("./agent-session-attachments.js");
  const store = new attachments.AgentSessionAttachments(f.store.database, join(directories[0]!, "attachments"));
  const uploaded = await store.upload(dispatchSession, "owner", "evidence.log", "text/plain", Buffer.from("log line 1\n"));
  const commandId = randomUUID();
  f.db.prepare(`INSERT INTO agent_session_commands(id,session_id,account_id,kind,text,status,created_at)
    VALUES (?,?,'owner','message','请看日志','delivered',?)`).run(commandId, dispatchSession, f.now);
  store.bind(dispatchSession, "owner", commandId, [uploaded.id]);

  const result = f.reads.readConversation("owner", dispatchSession, { itemKey: f.item.key });
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]).toMatchObject({ filename: "evidence.log", kind: "log", commandId, command: { text: "请看日志", status: "delivered" } });

  const file = f.reads.attachmentFile("owner", dispatchSession, uploaded.id, f.item.key);
  expect(file.attachment.sha256).toBe(uploaded.sha256);
  expect(() => f.reads.attachmentFile("owner", dispatchSession, randomUUID(), f.item.key)).toThrow(/not found/i);
});

it("serves the three read tools on a read-only connection and enforces product scope over HTTP", async () => {
  const salt = Buffer.from("missiongo-test-salt");
  const adminAccount: AdminAccountConfig = {
    id: "account-test-1", username: "mission-owner",
    passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("correct horse", salt, 64).toString("base64url")}`,
    sessionSecret: "test-session-secret-that-is-not-used-in-production", cookieSecure: true,
  };
  const directory = await mkdtemp(join(tmpdir(), "missiongo-session-mcp-"));
  directories.push(directory);
  const app = buildApp({
    databasePath: join(directory, "missiongo.sqlite"),
    attachmentsPath: join(directory, "attachments"),
    adminToken: "management-test-token",
    adminAccount,
    publicOrigin: "https://missiongo.test",
    writeTools: "none",
  });
  apps.push(app);
  const store = app.missionGoStore;
  const db = store.database.connection;
  const product = store.createProduct({ name: "Hermes Go", keyPrefix: "HG" });
  const otherProduct = store.createProduct({ name: "Other Go", keyPrefix: "OG" });

  const item = store.createWorkItem({ productId: product.id, title: "Crash", description: "On launch", type: "bug", priority: "high", environment: { platform: "web" } });
  store.transitionWorkItem({ itemKey: item.key, to: "ready", reason: "triaged", actor: "human" });
  store.claimWorkItem({ itemKey: item.key, agentId: "codex", idempotencyKey: "claim" });
  const crossItem = store.createWorkItem({ productId: otherProduct.id, title: "Elsewhere", description: "Work", type: "task", priority: "normal", environment: { platform: "web" } });
  store.transitionWorkItem({ itemKey: crossItem.key, to: "ready", reason: "triaged", actor: "human" });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,last_seen_at,created_at,updated_at)
    VALUES ('node',?,'installation','Example node','synthetic','[{"kind":"codex"}]',?,?,?)`)
    .run(adminAccount.id, now, now, now);
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at,unread_at)
    VALUES ('dispatch',?, 'node','codex','default','launched','/repo',?,?)`).run(adminAccount.id, now, now);
  db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run("dispatch", item.id);
  db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,1)").run("dispatch", crossItem.id);
  const sessionId = new AgentSessionStore(store.database).createForDispatch({ dispatchId: "dispatch", nodeId: "node", sessionRef: "native-thread" });
  db.prepare(`INSERT INTO agent_session_messages(id,session_id,source_id,role,text,position,observed_at,occurred_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), sessionId, "user-1", "user", "Fix it", 0, now, now);

  const adminToken = createAiAccessToken(adminAccount, { id: adminAccount.id, username: adminAccount.username, role: "admin" },
    app.missionGoAccounts.credentialsStamp(app.missionGoAccounts.getAccount(adminAccount.id)), "read-client", ["missiongo:read"]).token;
  const call = async (method: string, params: Readonly<Record<string, unknown>>) => {
    const response = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
    const payload = response.headers["content-type"]?.includes("text/event-stream")
      ? response.body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      : response.body;
    return JSON.parse(payload!) as { result?: { structuredContent?: Record<string, unknown>; tools?: Array<{ name: string }> }; error?: { message?: string } };
  };

  const tools = await call("tools/list", {});
  const names = (tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  for (const tool of ["list_item_agent_sessions", "get_agent_session", "get_item_plan_approvals", "get_review_content", "get_agent_history", "get_agent_artifact"]) {
    expect(names).toContain(tool);
  }

  // Restrict the owning account to the first product: the conversation spans the
  // second one, so it disappears from the listing and a direct read is refused --
  // and the already-issued token picks the restriction up immediately.
  app.missionGoAccounts.replacePermissions(adminAccount.id, [{ productId: product.id, canView: true, canOperate: true, canUseAi: true }], "selected");
  for(const [name,args] of [
    ["get_review_content",{kind:"plan",id:sessionId,itemKey:item.key}],
    ["get_agent_history",{sessionId,itemKey:item.key}],
    ["get_agent_artifact",{sessionId,itemKey:item.key,sourceId:"user-1",href:"/tmp/secret.md"}],
  ] as const) {
    const denied=await call("tools/call",{name,arguments:args});
    expect(JSON.stringify(denied)).toMatch(/isError|error/);
    expect(denied.result?.structuredContent).toBeUndefined();
  }
  const restrictedListing = await call("tools/call", { name: "list_item_agent_sessions", arguments: { itemKey: item.key } });
  expect((restrictedListing.result?.structuredContent as { conversations?: unknown[] })?.conversations).toEqual([]);
  const restrictedRead = await call("tools/call", { name: "get_agent_session", arguments: { sessionId, itemKey: item.key } });
  expect(JSON.stringify(restrictedRead)).toContain("not permitted");

  // With both products back in scope the conversation is listed through the
  // first item, carries both items, and the transcript reads.
  app.missionGoAccounts.replacePermissions(adminAccount.id, [
    { productId: product.id, canView: true, canOperate: true, canUseAi: true },
    { productId: otherProduct.id, canView: true, canOperate: true, canUseAi: true },
  ], "selected");
  const adminListing = await call("tools/call", { name: "list_item_agent_sessions", arguments: { itemKey: item.key } });
  expect((adminListing.result?.structuredContent as { conversations?: Array<{ sessionId: string; items: Array<{ key: string }> }> })?.conversations)
    .toEqual([expect.objectContaining({ sessionId, items: expect.arrayContaining([expect.objectContaining({ key: item.key }), expect.objectContaining({ key: crossItem.key })]) })]);
  const adminRead = await call("tools/call", { name: "get_agent_session", arguments: { sessionId, itemKey: item.key, limit: 10 } });
  expect((adminRead.result?.structuredContent as { messages?: Array<{ sourceId?: string }> })?.messages).toEqual([expect.objectContaining({ sourceId: "user-1" })]);
  const artifacts=new AgentArtifacts(store.database,join(directory,"attachments","agent-artifacts"));
  const history=new AgentHistory(store.database,artifacts);
  history.observe(adminAccount.id,"node",sessionId,{cursor:"issued-source-anchor",complete:false});
  const invoke=async(name:string,args:Record<string,unknown>)=>(await call("tools/call",{name,arguments:args})).result?.structuredContent;
  const available=await invoke("get_agent_history",{sessionId,itemKey:item.key});
  const cursor=available!.nextCursor as string;
  expect(await invoke("get_agent_history",{sessionId,itemKey:item.key,cursor})).toMatchObject({status:"pending"});
  history.complete(adminAccount.id,"node",cursor,{messages:[{sourceId:"older-output",role:"agent",text:"[Report](/tmp/output/report.md)"}]});
  const source=await invoke("get_agent_history",{sessionId,itemKey:item.key,cursor});
  expect(source).toMatchObject({status:"ready",messages:[{sourceId:"older-output"}]});
  const reread=await invoke("get_agent_session",{sessionId,itemKey:item.key});
  expect((reread!.messages as {sourceId:string}[]).some(m=>m.sourceId==="older-output")).toBe(true);
  const requested=await invoke("get_agent_artifact",{sessionId,itemKey:item.key,sourceId:"older-output",href:"/tmp/output/report.md"});
  expect(requested).toMatchObject({status:"pending",contentRead:false});
  await artifacts.complete(adminAccount.id,"node",requested!.id as string,{error:"resource_missing",errorResource:"images/chart.png"});
  expect(await invoke("get_agent_artifact",{sessionId,itemKey:item.key,artifactId:requested!.id})).toMatchObject({status:"failed",errorResource:"images/chart.png"});
  await invoke("get_agent_artifact",{sessionId,itemKey:item.key,sourceId:"older-output",href:"/tmp/output/report.md"});
  await artifacts.complete(adminAccount.id,"node",requested!.id as string,{bundle:{entry:"report.md",skippedResources:["evidence.jsonl"],files:[{name:"report.md",contentType:"text/markdown",base64:Buffer.from("# Complete report 🧑‍💻").toString("base64")}]}});
  const saved=await invoke("get_agent_artifact",{sessionId,itemKey:item.key,artifactId:requested!.id});
  expect(JSON.parse(saved!.text as string).text).toBe("# Complete report 🧑‍💻");
  expect(saved).toMatchObject({skippedResources:["evidence.jsonl"]});
  const denied=await invoke("get_agent_artifact",{sessionId,itemKey:item.key,sourceId:"older-output",href:"/tmp/unmentioned-secret.md"});
  expect(denied).toBeUndefined();
  expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toEqual({n:0});

});

it("reports persisted implementation-plan records honestly across revisions, scope drift and external identities", async () => {
  const f = await fixture();
  f.createDispatchSession("dispatch", "native-thread");
  const plans = new ImplementationPlans(f.store.database);
  const identity = "dispatch:dispatch";
  const keys = [f.item.key];
  const infos = () => f.reads.planApprovalInfos("owner", f.item.key);

  const revision = planDigest([identity, plans.scope(keys), "方案 A", "验证 A"]);
  plans.request("owner", identity, revision, { keys, plan: "方案 A", validation: "验证 A" });
  expect(infos()[0]!.formalRecords).toMatchObject({
    available: true,
    records: [{ identity, revision, keys, plan: "方案 A", approved: false, scopeValid: true }],
  });

  plans.record({ accountId: "owner", identity, revision, planHash: revision, keys, source: "web", plan: "方案 A", validation: "验证 A" });
  expect(infos()[0]!.formalRecords.records![0]).toMatchObject({
    approved: true, scopeValid: true, plan: "方案 A", approval: { source: "web", current: true, revision },
  });

  // A newer request revision supersedes the old approval.
  const revision2 = planDigest([identity, plans.scope(keys), "方案 B", "验证 B"]);
  plans.request("owner", identity, revision2, { keys, plan: "方案 B", validation: "验证 B" });
  expect(infos()[0]!.formalRecords.records![0]).toMatchObject({
    revision: revision2, approved: false, approval: { current: false },
  });

  // Approving the current revision counts -- until the item content drifts past
  // the frozen scope.
  plans.record({ accountId: "owner", identity, revision: revision2, planHash: revision2, keys, source: "native", plan: "方案 B", validation: "验证 B" });
  expect(infos()[0]!.formalRecords.records![0]).toMatchObject({ approved: true });
  f.db.prepare("UPDATE work_items SET content_version=content_version+1 WHERE id=?").run(f.item.id);
  expect(infos()[0]!.formalRecords.records![0]).toMatchObject({ approved: false, scopeValid: false });

  // External conversations are matched through their native identity suffix.
  const externalId = f.external.register(owner, { agentKind: "codex", sessionRef: "ext-thread", refKind: "native" }, f.item.key);
  const extIdentity = "native:writer-client:codex:native:ext-thread";
  const extRevision = planDigest([extIdentity, plans.scope(keys), "外部方案", "外部验证"]);
  plans.request("owner", extIdentity, extRevision, { keys, plan: "外部方案", validation: "外部验证" });
  plans.record({ accountId: "owner", identity: extIdentity, revision: extRevision, planHash: extRevision, keys, source: "web", plan: "外部方案", validation: "外部验证" });
  const externalInfo = infos().find((info) => info.sessionId === externalId)!;
  expect(externalInfo.formalRecords.records![0]).toMatchObject({ identity: extIdentity, approved: true });
});

it("keeps reads side-effect free on item and session state", async () => {
  const f = await fixture();
  const dispatchSession = f.createDispatchSession("dispatch", "native-thread");
  const before = {
    item: f.store.getWorkItem(f.item.key).status,
    sessionStatus: (f.db.prepare("SELECT status FROM agent_sessions WHERE id=?").get(dispatchSession) as { status: string }).status,
    commands: (f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get() as { n: number }).n,
    reports: (f.db.prepare("SELECT COUNT(*) AS n FROM external_agent_session_reports").get() as { n: number }).n,
  };
  f.reads.listConversations("owner", f.item.key);
  f.reads.readConversation("owner", dispatchSession, { itemKey: f.item.key });
  f.reads.planApprovalInfos("owner", f.item.key);
  expect({
    item: f.store.getWorkItem(f.item.key).status,
    sessionStatus: (f.db.prepare("SELECT status FROM agent_sessions WHERE id=?").get(dispatchSession) as { status: string }).status,
    commands: (f.db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get() as { n: number }).n,
    reports: (f.db.prepare("SELECT COUNT(*) AS n FROM external_agent_session_reports").get() as { n: number }).n,
  }).toEqual(before);
});

it("does not expose cached execution records through the conversation read API", async () => {
  const f = await fixture(); const id = f.createDispatchSession("dispatch", "native-thread");
  f.dispatchMessage(id, "tool", "agent", "private output", f.now);
  f.db.prepare("UPDATE agent_session_messages SET phase='execution' WHERE session_id=?").run(id);
  f.dispatchMessage(id, "reply", "agent", "Visible reply", f.now);
  const result = f.reads.readConversation("owner", id, { itemKey: f.item.key, offset: 0, limit: 10 });
  expect(result.messages.map(message => message.text)).toEqual(["Visible reply"]);
});
