import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MissionGoStore } from "../store.js";
import { ImplementationPlans } from "../implementation-plans.js";

it("restores saved permissions on upgrade without changing actual modes or approvals", () => {
  const root = mkdtempSync(join(tmpdir(), "missiongo-plan-permissions-"));
  const path = join(root, "fixture.sqlite");
  let store = new MissionGoStore(path);
  try {
    const product = store.createProduct({ name: "Migration", keyPrefix: "MIG" });
    const item = store.createWorkItem({ productId: product.id, title: "Scoped change", description: "Scope",
      status: "ready", type: "task", priority: "normal", environment: { platform: "shared" } });
    const db = store.database.connection;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO nodes(id,account_id,installation_id,name,token_hash,created_at,updated_at)
      VALUES ('node','owner','fixture','Fixture','synthetic',?,?)`).run(now, now);
    const cases = [
      ["claude_code", "bypassPermissions"], ["claude_code", "plan"],
      ["codex", "auto"], ["codex", "read-only"], ["opencode", "build"], ["opencode", "plan"],
    ];
    for (const [kind, mode] of cases) {
      const id = `${kind}-${mode}`;
      db.prepare(`INSERT INTO dispatches(id,account_id,node_id,agent_kind,mode,status,repo_path,created_at)
        VALUES (?,'owner','node',?,?,'launched','/synthetic/repo',?)`).run(id, kind!, mode!, now);
      db.prepare("INSERT INTO dispatch_items(dispatch_id,item_id,position) VALUES (?,?,0)").run(id, item.id);
      db.prepare(`INSERT INTO agent_sessions(id,dispatch_id,node_id,agent_kind,agent_session_ref,status,mode,
        implementation_mode,desired_settings_json,settings_revision,applied_settings_revision,created_at,updated_at)
        VALUES (?,?,'node',?,?,'idle',?,?,?,4,4,?,?)`).run(id, id, kind!, id,
        kind === "codex" ? "read-only" : "plan", mode!,
        JSON.stringify({ mode: kind === "codex" ? "read-only" : "plan", planning: true, planApproved: false,
          model: "fixture-model", effort: "high" }), now, now);
      const plans = new ImplementationPlans(store.database);
      plans.request("owner", `dispatch:${id}`, "proposal", { keys: [item.key], plan: "Do the scoped work", validation: "Verify it" });
    }
    // The original forced startup had no desired settings or saved implementation mode yet.
    db.prepare("UPDATE agent_sessions SET desired_settings_json=NULL,implementation_mode=NULL,settings_revision=0,applied_settings_revision=0 WHERE id='opencode-build'").run();
    const approved = new ImplementationPlans(store.database);
    approved.record({ accountId: "owner", identity: "dispatch:codex-auto", revision: "proposal", planHash: "proposal",
      keys: [item.key], source: "web", plan: "Do the scoped work", validation: "Verify it" });
    const approvals = db.prepare("SELECT * FROM implementation_plan_approvals").all();
    const requests = db.prepare("SELECT * FROM implementation_plan_requests").all();
    const actualModes = db.prepare("SELECT id,mode,applied_settings_revision FROM agent_sessions ORDER BY id").all();
    db.prepare("DELETE FROM schema_migrations WHERE version=202611051359").run();
    store.close();
    store = new MissionGoStore(path);
    const upgraded = store.database.connection;
    for (const [kind, mode] of cases) {
      const row = upgraded.prepare("SELECT implementation_mode,desired_settings_json,settings_revision FROM agent_sessions WHERE id=?")
        .get(`${kind}-${mode}`) as { implementation_mode: string; desired_settings_json: string; settings_revision: number };
      expect(row.implementation_mode).toBe(mode);
      expect(JSON.parse(row.desired_settings_json)).toMatchObject({ mode, planning: false });
      expect(JSON.parse(row.desired_settings_json).planApproved).toBeUndefined();
      expect(row.settings_revision).toBe(kind === "opencode" && mode === "build" ? 1 : 5);
      if (!(kind === "opencode" && mode === "build")) {
        expect(JSON.parse(row.desired_settings_json)).toMatchObject({ model: "fixture-model", effort: "high" });
      }
    }
    expect(upgraded.prepare("SELECT id,mode,applied_settings_revision FROM agent_sessions ORDER BY id").all()).toEqual(actualModes);
    expect(upgraded.prepare("SELECT * FROM implementation_plan_approvals").all()).toEqual(approvals);
    expect(upgraded.prepare("SELECT * FROM implementation_plan_requests").all()).toEqual(requests);
    const restored = upgraded.prepare("SELECT * FROM agent_sessions ORDER BY id").all();
    store.close();
    store = new MissionGoStore(path);
    expect(store.database.connection.prepare("SELECT * FROM agent_sessions ORDER BY id").all()).toEqual(restored);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
