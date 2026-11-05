import { scryptSync } from "node:crypto";
import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { McpAgentSessionReads } from "./mcp-agent-session-reads.js";

it("serves recent cached messages, queues an exact read-only page and authorizes its historical output links", async () => {
  const salt = Buffer.from("history-route-fixture");
  const app = buildApp({ databasePath: ":memory:", adminAccount: {
    id: "owner", username: "owner@example.test", passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("test-password", salt, 64).toString("base64url")}`,
    sessionSecret: "synthetic-history-route-session-secret", cookieSecure: false,
  } });
  try {
    const store = app.missionGoStore; const db = store.database.connection;
    const product = store.createProduct({ name: "History fixture", keyPrefix: "HF" });
    const item = store.createWorkItem({ productId: product.id, title: "History fixture", description: "", type: "bug", priority: "normal" });
    const node = new DispatchStore(store.database).registerNode({ accountId: "owner", name: "Fixture", installationId: "history-node" });
    const other = new DispatchStore(store.database).registerNode({ accountId: "owner", name: "Other", installationId: "other-history-node" });
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES ('history-dispatch','owner',?,'codex','default','launched','synthetic',?)`).run(node.nodeId, new Date().toISOString());
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('history-dispatch',?,0)").run(item.id);
    const sessions = new AgentSessionStore(store.database);
    const id = sessions.createForDispatch({ dispatchId: "history-dispatch", nodeId: node.nodeId, sessionRef: "exact-history-thread" });
    const messages = Array.from({ length: 120 }, (_, n) => ({ sourceId: `message-${n}`, role: "agent" as const, text: `Message ${n}` }));
    const nodeHeaders = { authorization: `Bearer ${node.token}` };
    const snapshot = await app.inject({ method: "POST", url: `/api/v1/node/agent-sessions/${id}/snapshot`, headers: nodeHeaders,
      payload: { status: "idle", messages, history: { cursor: "opaque-history-anchor", complete: false } } });
    expect(snapshot.statusCode).toBe(204);
    const context = new McpAgentSessionReads(store, "/synthetic/history-attachments").readConversation("owner", id, { itemKey: item.key });
    expect(context.completeness.knownGaps.some(gap => gap.includes("bounded history window"))).toBe(true);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner@example.test", password: "test-password" } });
    const headers = { cookie: login.headers["set-cookie"]!.split(";", 1)[0]! };
    const detail = await app.inject({ method: "GET", url: `/api/v1/agent-sessions/${id}?history=recent`, headers });
    expect(detail.statusCode).toBe(200); expect(detail.json().messages).toHaveLength(50);
    const url = `/api/v1/agent-sessions/${id}/history`;
    const load = (cursor: string) => app.inject({ method: "POST", url, headers, payload: { cursor } });
    const middle = (await load(detail.json().history.nextCursor)).json();
    expect(middle.messages).toHaveLength(50);
    const oldest = (await load(middle.nextCursor)).json(); expect(oldest.messages).toHaveLength(20);
    const pending = await load(oldest.nextCursor); expect(pending.json().status).toBe("pending");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_session_commands").get()).toEqual({ n: 0 });
    const jobs = await app.inject({ method: "GET", url: "/api/v1/node/agent-history", headers: nodeHeaders });
    const job = jobs.json().jobs[0]; expect(job).toMatchObject({ sessionRef: "exact-history-thread", cursor: "opaque-history-anchor" });
    const result = { messages: [{ sourceId: "older-output", role: "agent", text: "[Original report](/tmp/history-fixture/report.md)" }] };
    expect((await app.inject({ method: "POST", url: `/api/v1/node/agent-history/${job.id}`, headers: { authorization: `Bearer ${other.token}` }, payload: result })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/node/agent-history/${job.id}`, headers: nodeHeaders, payload: result })).statusCode).toBe(204);
    const cached = await app.inject({ method: "GET", url: `${url}?cursor=${encodeURIComponent(oldest.nextCursor)}`, headers });
    expect(cached.json()).toMatchObject({ status: "ready", messages: [{ sourceId: "older-output" }] });
    expect((await load(oldest.nextCursor)).json().status).toBe("ready");
    const artifact = await app.inject({ method: "POST", url: `/api/v1/agent-sessions/${id}/artifacts`, headers,
      payload: { messageId: cached.json().messages[0].id, href: "/tmp/history-fixture/report.md" } });
    expect(artifact.statusCode).toBe(200); expect(artifact.json().status).toBe("pending");
    expect((await app.inject({ method: "POST", url, headers, payload: { cursor: "arbitrary-unissued-token" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${url}?cursor=${job.id}` })).statusCode).toBe(401);
  } finally { await app.close(); }
});
