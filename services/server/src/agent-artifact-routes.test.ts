import { scryptSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DispatchStore } from "./dispatch-store.js";
import { AgentSessionStore } from "./agent-session-store.js";

it("recovers an archived link through its owning node, persists it offline, and rejects unreferenced and unauthorized requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-routes-"));
  const salt = Buffer.from("artifact-test-salt");
  const app = buildApp({ databasePath: join(root, "db.sqlite"), attachmentsPath: join(root, "files"), adminAccount: {
    id: "owner", username: "owner@example.test", passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("test-password", salt, 64).toString("base64url")}`,
    sessionSecret: "synthetic-artifact-route-session-secret", cookieSecure: false,
  } });
  try {
    const store = app.missionGoStore;
    const db = store.database.connection;
    const product = store.createProduct({ name: "Fixture", keyPrefix: "EX" });
    const item = store.createWorkItem({ productId: product.id, title: "Fixture", description: "", type: "bug", priority: "normal" });
    const node = new DispatchStore(store.database).registerNode({ accountId: "owner", name: "Fixture", installationId: "fixture-node" });
    const other = new DispatchStore(store.database).registerNode({ accountId: "owner", name: "Other", installationId: "other-fixture-node" });
    db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES ('dispatch','owner',?,'codex','default','launched','synthetic',?)`).run(node.nodeId, new Date().toISOString());
    db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES ('dispatch',?,0)").run(item.id);
    const sessions = new AgentSessionStore(store.database);
    const id = sessions.createForDispatch({ dispatchId: "dispatch", nodeId: node.nodeId, sessionRef: "native-thread" });
    const href = "/tmp/fixture-preview/prototype.html";
    sessions.recordSnapshot({ nodeId: node.nodeId, sessionId: id, status: "idle", messages: [
      { sourceId: "source", role: "agent", text: `[查看](${href})` }, { sourceId: "user-source", role: "user", text: `[查看](${href})` },
    ] });
    db.prepare("UPDATE agent_sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), id);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner@example.test", password: "test-password" } });
    const headers = { cookie: login.headers["set-cookie"]!.split(";", 1)[0]! };
    const detail = sessions.getForAccount("owner", id);
    const messageId = detail.messages[0]!.id;
    const url = `/api/v1/agent-sessions/${id}/artifacts`;
    const request = (payload = { messageId, href }) => app.inject({ method: "POST", url, headers, payload });
    expect((await app.inject({ method: "POST", url, payload: { messageId, href } })).statusCode).toBe(401);
    expect((await request({ messageId, href: "/tmp/unreferenced.txt" })).statusCode).toBe(404);
    expect((await request({ messageId: detail.messages[1]!.id, href })).statusCode).toBe(404);
    const result = await request(); expect(result.statusCode).toBe(200);
    const artifact = result.json(); expect(artifact.status).toBe("pending");
    const nodeHeaders = { authorization: `Bearer ${node.token}` };
    const jobs = await app.inject({ method: "GET", url: "/api/v1/node/agent-artifacts", headers: nodeHeaders });
    expect(jobs.json().jobs).toMatchObject([{ id: artifact.id, sessionId: id, sourceId: "source", href }]);
    const report = `/api/v1/node/agent-artifacts/${artifact.id}`;
    const bundle = { entry: "prototype.html", files: [{ name: "prototype.html", contentType: "text/html", base64: Buffer.from("<button>Preview</button>").toString("base64") }] };
    expect((await app.inject({ method: "POST", url: report, headers: { authorization: `Bearer ${other.token}` }, payload: { bundle } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: report, headers: nodeHeaders, payload: { bundle } })).statusCode).toBe(204);
    db.prepare("UPDATE nodes SET revoked_at=? WHERE id=?").run(new Date().toISOString(), node.nodeId);
    const saved = await app.inject({ method: "GET", url: `${url}/${artifact.id}/bundle`, headers });
    expect(saved.statusCode).toBe(200); expect(saved.json()).toEqual(bundle);
    expect((await request()).json().status).toBe("ready");
    app.missionGoAccounts.createAccount({ email: "second-admin@example.test", password: "test-password", role: "admin" });
    app.missionGoAccounts.updateAccount("owner", { role: "member" });
    app.missionGoAccounts.replacePermissions("owner", [{ productId: product.id, canView: true, canOperate: false, canUseAi: false }]);
    expect((await request()).json().status).toBe("ready");
    sessions.recordSnapshot({ nodeId: node.nodeId, sessionId: id, status: "idle", messages: [{ sourceId: "unsaved", role: "agent", text: "[新文件](/tmp/fixture-preview/unsaved.md)" }] });
    const unsaved = sessions.getForAccount("owner", id).messages.find((message) => message.sourceId === "unsaved")!;
    expect((await request({ messageId: unsaved.id, href: "/tmp/fixture-preview/unsaved.md" })).statusCode).toBe(404);
    const preview = await app.inject({ method: "GET", url: `${url}/${artifact.id}/preview`, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-security-policy"]).toContain("sandbox allow-scripts;");
    expect(preview.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(preview.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect((await app.inject({ method: "GET", url: `${url}/${artifact.id}/bundle` })).statusCode).toBe(401);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
