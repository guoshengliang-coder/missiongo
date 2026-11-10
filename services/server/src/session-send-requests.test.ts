import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionGoDatabase } from "./storage/database.js";
import { SessionSendRequests } from "./session-send-requests.js";
import { AgentSessionAttachments } from "./agent-session-attachments.js";
const databases: MissionGoDatabase[] = [];
const dirs: string[] = [];
afterEach(async () => { databases.splice(0).forEach(db => db.close()); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture() { const db = new MissionGoDatabase(":memory:"); databases.push(db); return db; }
it("rolls back both the command creation and request record when creation fails", () => {
  const db = fixture(), requests = new SessionSendRequests(db);
  const key = "atomic-request-key-499";
  expect(() => requests.run("owner", "session", "command", key, ["text"], () => undefined, () => {
    db.connection.prepare("INSERT INTO idempotency_keys VALUES ('temporary','fixture','{}','now')").run();
    throw new Error("binding failed");
  })).toThrow("binding failed");
  expect(requests.get("owner", "session", "command", key)).toBeUndefined();
  expect(db.connection.prepare("SELECT 1 FROM idempotency_keys WHERE key='temporary'").get()).toBeUndefined();
});
it("isolates identical keys by account, session and operation", () => {
  const db = fixture(), requests = new SessionSendRequests(db);
  requests.run("owner", "session", "command", "scope-request-key-499", ["a"], () => undefined, () => ({ id: "one" }));
  expect(requests.get("other", "session", "command", "scope-request-key-499")).toBeUndefined();
  expect(requests.get("owner", "other", "command", "scope-request-key-499")).toBeUndefined();
  expect(requests.get("owner", "session", "upload", "scope-request-key-499")).toBeUndefined();
});
it.each([false, true])("deduplicates concurrent uploads and lost acknowledgements at the draft limit (external=%s)", async external => {
  const db = fixture(); const dir = await mkdtemp(join(tmpdir(), "and499-uploads-")); dirs.push(dir);
  const stamp = "2026-11-10T00:00:00Z";
  if (external) db.connection.prepare(`INSERT INTO external_agent_sessions(id,account_id,client_id,agent_kind,session_ref,ref_kind,progress_status,created_at,updated_at,activity_at)
    VALUES ('session','owner','fixture','codex','fixture','native','working',?,?,?)`).run(stamp, stamp, stamp);
  else {
    db.connection.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,agents_json,created_at,updated_at)
      VALUES ('node','owner','fixture','Fixture','synthetic','[]',?,?)`).run(stamp, stamp);
    db.connection.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
      VALUES ('dispatch','owner','node','codex','plan','launched','fixture',?)`).run(stamp);
    db.connection.prepare(`INSERT INTO agent_sessions(id,dispatch_id,node_id,agent_kind,agent_session_ref,status,created_at,updated_at)
      VALUES ('session','dispatch','node','codex','fixture','idle',?,?)`).run(stamp, stamp);
  }
  const attachments = new AgentSessionAttachments(db, dir, external);
  const bytes = Buffer.from("same file");
  const [first, second] = await Promise.all([attachments.upload("session", "owner", "a.txt", "text/plain", bytes, "file-request-key-499"),
    attachments.upload("session", "owner", "a.txt", "text/plain", bytes, "file-request-key-499")]);
  expect(second.id).toBe(first.id);
  expect(await readdir(attachments.rootPath)).toHaveLength(1);
  await expect(attachments.upload("session", "owner", "a.txt", "text/plain", Buffer.from("changed"), "file-request-key-499")).rejects.toThrow(/different content/);
  for (let i = 0; i < 9; i++) await attachments.upload("session", "owner", "a.txt", "text/plain", bytes);
  expect((await attachments.upload("session", "owner", "a.txt", "text/plain", bytes, "file-request-key-499")).id).toBe(first.id);
  await expect(attachments.upload("session", "owner", "a.txt", "text/plain", bytes, "file-request-new-499")).rejects.toThrow(/at most 10/);
  expect(await readdir(attachments.rootPath)).toHaveLength(10);
  await attachments.removeDraft("session", "owner", first.id);
  await expect(attachments.upload("session", "owner", "a.txt", "text/plain", bytes, "file-request-key-499")).rejects.toThrow(/not found/i);
  expect(await readdir(attachments.rootPath)).toHaveLength(9);
  await attachments.upload("session", "owner", "a.txt", "text/plain", bytes, "explicit-new-file-key-499");
  expect(await readdir(attachments.rootPath)).toHaveLength(10);
});
