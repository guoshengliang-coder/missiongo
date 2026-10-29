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
