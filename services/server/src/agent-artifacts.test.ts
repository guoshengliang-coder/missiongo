import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentArtifacts, validateArtifactBundle } from "./agent-artifacts.js";
import { AgentSessionStore } from "./agent-session-store.js";
import { DispatchStore } from "./dispatch-store.js";
import { MissionGoStore } from "./store.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "artifact-store-"));
  const store = new MissionGoStore(join(root, "db.sqlite"));
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const nodes = new DispatchStore(store.database);
  const node = nodes.registerNode({ accountId: "owner", name: "Fixture", installationId: "fixture-node" });
  const now = new Date().toISOString();
  store.database.connection.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at) VALUES ('dispatch','owner',?,'codex','default','launched','synthetic',?)`).run(node.nodeId, now);
  const session = new AgentSessionStore(store.database).createForDispatch({ dispatchId: "dispatch", nodeId: node.nodeId, sessionRef: "native" });
  const artifacts = new AgentArtifacts(store.database, join(root, "outputs"));
  return { root, store, node, session, artifacts };
}
const bundle = { entry: "notes.md", files: [{ name: "notes.md", contentType: "text/markdown", base64: Buffer.from("# Saved\n").toString("base64") }] };

it("persists a saved artifact across reopen and node revocation without crossing accounts or sessions", async () => {
  const f = await fixture();
  const output = f.artifacts.request("owner", f.session, "message", "/tmp/fixture-output/notes.md", f.artifacts.binding("owner", f.session));
  expect(output.status).toBe("pending");
  expect(f.artifacts.jobs("other", f.node.nodeId)).toEqual([]);
  expect(() => f.artifacts.authorizeJob("owner", "wrong-node", output.id)).toThrow(/not found/);
  await f.artifacts.complete("owner", f.node.nodeId, output.id, { bundle });
  f.store.database.connection.prepare("UPDATE nodes SET revoked_at=? WHERE id=?").run(new Date().toISOString(), f.node.nodeId);
  const reopened = new AgentArtifacts(f.store.database, join(f.root, "outputs"));
  expect(await reopened.bundle("owner", f.session, output.id)).toEqual(bundle);
  expect(() => reopened.get("other", f.session, output.id)).toThrow(/not found/);
  expect(() => reopened.get("owner", "wrong-session", output.id)).toThrow(/not found/);
  expect(reopened.request("owner", f.session, "message", "/tmp/fixture-output/notes.md").status).toBe("ready");
});

it("rejects a result after its binding is revoked, records missing-file results and permits explicit retries", async () => {
  const f = await fixture();
  const output = f.artifacts.request("owner", f.session, "message", "/tmp/fixture-output/notes.md", f.artifacts.binding("owner", f.session));
  await f.artifacts.complete("owner", f.node.nodeId, output.id, { error: "file_missing" });
  expect(f.artifacts.get("owner", f.session, output.id)).toMatchObject({ status: "failed", error: "file_missing" });
  f.artifacts.request("owner", f.session, "message", "/tmp/fixture-output/notes.md", f.artifacts.binding("owner", f.session));
  f.store.database.connection.prepare("UPDATE nodes SET revoked_at=? WHERE id=?").run(new Date().toISOString(), f.node.nodeId);
  await expect(f.artifacts.complete("owner", f.node.nodeId, output.id, { bundle })).rejects.toThrow(/not found/);
});

it("rejects traversal, duplicate names, hidden files, noncanonical base64 and active resource type spoofing", () => {
  for (const bad of [
    { ...bundle, entry: "../notes.md", files: [{ ...bundle.files[0]!, name: "../notes.md" }] },
    { ...bundle, files: [...bundle.files, ...bundle.files] },
    { ...bundle, entry: ".private.txt", files: [{ ...bundle.files[0]!, name: ".private.txt" }] },
    { ...bundle, files: [{ ...bundle.files[0]!, base64: "bad!" }] },
    { ...bundle, files: [{ ...bundle.files[0]!, contentType: "text/html" }] },
  ]) expect(() => validateArtifactBundle(bad)).toThrow();
});

it("persists bounded relative failure details across reopen and clears them on retry", async () => {
  const f = await fixture();
  const result = f.artifacts.request("owner", f.session, "message", "/tmp/fixture-output/report.html", f.artifacts.binding("owner", f.session));
  expect(f.artifacts.jobs("owner", f.node.nodeId)[0]).toMatchObject({ diagnosticsProtocol: 1 });
  for (const errorResource of ["/etc/private", "../secret", "a\nsecret", ".env", "x".repeat(1025)]) {
    await expect(f.artifacts.complete("owner", f.node.nodeId, result.id, { error: "resource_missing", errorResource })).rejects.toThrow();
  }
  await f.artifacts.complete("owner", f.node.nodeId, result.id, { error: "resource_missing", errorResource: "assets/site.css" });
  expect(new AgentArtifacts(f.store.database, join(f.root, "outputs")).get("owner", f.session, result.id)).toMatchObject({ errorResource: "assets/site.css", error: "resource_missing" });
  f.artifacts.request("owner", f.session, "message", "/tmp/fixture-output/report.html", f.artifacts.binding("owner", f.session));
  expect(f.artifacts.get("owner", f.session, result.id)).not.toHaveProperty("errorResource");
  const saved = { ...bundle, skippedResources: ["evidence.jsonl"] };
  await f.artifacts.complete("owner", f.node.nodeId, result.id, { bundle: saved });
  expect(await f.artifacts.bundle("owner", f.session, result.id)).toEqual(saved);
});

it("rejects unsafe, supported, duplicate or excessive skipped resources", () => {
  for (const skippedResources of [["../evidence.jsonl"], ["/secret.jsonl"], ["site.css"], ["a.jsonl", "a.jsonl"], Array.from({ length: 64 }, (_, n) => `${n}.jsonl`)]) {
    expect(() => validateArtifactBundle({ ...bundle, skippedResources })).toThrow();
  }
});

it("prepares only explicit agent images, normalizes duplicate paths, and preserves a failed job across heartbeats", async () => {
  const f=await fixture(),message={sourceId:"image-source",role:"agent",text:"[图](</tmp/output/image a.png>) [同图](file:///tmp/output/image%20a.png) [文档](/tmp/output/notes.md)"};
  const prepare=()=>f.artifacts.prepare("owner",f.session,[{...message,sourceId:"user",role:"user"},{...message,sourceId:"log",phase:"execution"},message],[f.session]);
  prepare();prepare();
  const jobs=f.artifacts.jobs("owner",f.node.nodeId);
  expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({sourceId:"image-source"});
  await f.artifacts.complete("owner",f.node.nodeId,jobs[0]!.id,{error:"file_denied"});
  prepare();expect(f.artifacts.jobs("owner",f.node.nodeId)).toHaveLength(0);
  expect(f.artifacts.get("owner",f.session,jobs[0]!.id)).toMatchObject({status:"failed",error:"file_denied"});
});

it("bounds automatic pending work and retains foreground priority", async () => {
  const f=await fixture();
  const messages=Array.from({length:30},(_,i)=>({sourceId:`source-${i}`,role:"agent",text:`[image](/tmp/output/${i}.png)`}));
  f.artifacts.prepare("owner",f.session,messages,[f.session]);
  f.artifacts.prepare("owner",f.session,messages,[f.session]);
  expect((f.store.database.connection.prepare("SELECT COUNT(*) AS n FROM agent_artifacts WHERE automatic=1").get() as {n:number}).n).toBe(8);
  const foreground=f.artifacts.request("owner",f.session,"manual","/tmp/output/manual.png",f.artifacts.binding("owner",f.session));
  expect(f.artifacts.jobs("owner",f.node.nodeId)[0]!.id).toBe(foreground.id);
});

it("retries unfinished files twice with a delay, then keeps explicit retry and a durable size projection", async () => {
  const f=await fixture();
  f.artifacts.prepare("owner",f.session,[{sourceId:"source",role:"agent",text:"[image](/tmp/output/image.png)"}],[f.session]);
  const job=f.artifacts.jobs("owner",f.node.nodeId)[0]!;
  for(let i=0;i<3;i++) {
    await f.artifacts.complete("owner",f.node.nodeId,job.id,{error:"file_missing"});
    expect(f.artifacts.jobs("owner",f.node.nodeId)).toHaveLength(0);
    f.store.database.connection.prepare("UPDATE agent_artifacts SET retry_at=? WHERE id=? AND retry_at IS NOT NULL").run("2020-01-01T00:00:00Z",job.id);
    expect(f.artifacts.jobs("owner",f.node.nodeId)).toHaveLength(i<2?1:0);
  }
  f.artifacts.request("owner",f.session,"source","/tmp/output/image.png",f.artifacts.binding("owner",f.session));
  const image={entry:"image.png",files:[{name:"image.png",contentType:"image/png",base64:Buffer.from("fixture").toString("base64")}]};
  await f.artifacts.complete("owner",f.node.nodeId,job.id,{bundle:image});
  const projection=await f.artifacts.readyImages("owner",[f.session]);
  expect(projection).toEqual([{id:job.id,sourceId:"source",href:"/tmp/output/image.png",sizeBytes:Buffer.byteLength(JSON.stringify(image))}]);
  f.store.database.connection.prepare("UPDATE agent_artifacts SET bundle_bytes=NULL WHERE id=?").run(job.id);
  expect(await f.artifacts.readyImages("owner",[f.session])).toEqual(projection);
  expect(await f.artifacts.readyImages("other",[f.session])).toEqual([]);
});


it("checks the original binding's revocation even when a pending copy belongs to an unrevoked mirror",async()=>{
  const f=await fixture(),db=f.store.database.connection,now=new Date().toISOString();
  db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
    VALUES ('mirror-dispatch','owner',?,'codex','default','launched','synthetic',?)`).run(f.node.nodeId,now);
  const mirror=new AgentSessionStore(f.store.database).createForDispatch({dispatchId:"mirror-dispatch",nodeId:f.node.nodeId,sessionRef:"native"});
  const output=f.artifacts.request("owner",mirror,"source","/tmp/output/image.png",f.artifacts.binding("owner",f.session));
  const product=f.store.createProduct({name:"Fixture",keyPrefix:"REVOKE"});
  const item=f.store.createWorkItem({productId:product.id,title:"Fixture",description:"",type:"task",priority:"normal"});
  db.prepare(`INSERT INTO builder_handovers(id,item_id,initiated_by,note,status,created_at,updated_at)
    VALUES ('handover',?,'owner','Transfer','completed',?,?)`).run(item.id,now,now);
  db.prepare("INSERT INTO builder_revoked_dispatches(dispatch_id,handover_id) VALUES ('dispatch','handover')").run();
  await expect(f.artifacts.complete("owner",f.node.nodeId,output.id,{bundle})).rejects.toThrow(/Builder/);
  expect(f.artifacts.jobs("owner",f.node.nodeId)).toEqual([]);
  expect(f.artifacts.get("owner",mirror,output.id).status).toBe("failed");
});
