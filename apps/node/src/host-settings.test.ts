import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { hostCall, hostDirectory } from "./host.js";
import { privateDir, readPrivate, saveConfig, savePrivate } from "./storage.js";
import type { HostState, Session } from "./types.js";

const roots: string[] = [], hosts: ChildProcess[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    if (host.exitCode !== null || host.signalCode !== null) continue;
    const exited = once(host, "exit");
    try { process.kill(-host.pid!, "SIGTERM"); } catch { /* Already exited. */ }
    await Promise.race([exited, delay(1000)]);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("the detached host blocks failed settings on every poll, preserves stop, and accepts a newer confirmed revision", async () => {
  const root = mkdtempSync("/tmp/mg-host-settings-"); roots.push(root);
  const fixture = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url)); chmodSync(fixture, 0o755);
  const claudeConfig = join(root, "claude"), events = join(root, "events");
  privateDir(join(claudeConfig, "skills/missiongo"));
  // A real skill-shaped file avoids downloads or changes to the user's skills.
  writeFileSync(join(claudeConfig, "skills/missiongo/SKILL.md"), "---\nversion: 1.0.0\n---\nFixture only", { mode: 0o600 });
  saveConfig(root, { installationId: "fixture", server: "https://missiongo.example.com", agents: { claude_code: { executable: fixture } } });
  savePrivate(join(root, "status.json"), { agents: [{ kind: "claude_code", skill: { expectedVersion: "1.0.0" } }] });
  const dispatch = { dispatchId: "settings", agentKind: "claude_code", repoPath: root, freeSession: true, itemKeys: [], mode: "acceptEdits" };
  const statePath = join(hostDirectory(root, "settings"), "state.json");
  savePrivate(statePath, { dispatch, pid: 0, phase: "starting", sessionName: "Isolated fixture", snapshot: { status: "idle", messages: [] }, commands: {} });
  const source = new URL("./host.ts", import.meta.url).href;
  const script = `import {runHost} from ${JSON.stringify(source)}; await runHost(process.argv[1], process.argv[2]);`;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx/esm"), "--input-type=module", "-e", script, root, "settings"], {
    detached: true, stdio: "ignore", env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig, TEST_AGENT_EVENTS: events, FAKE_CLAUDE_REJECT_MODE: "plan" },
  });
  hosts.push(child);
  for (let n = 0; n < 200 && readPrivate<HostState>(statePath)?.phase === "starting"; n++) await delay(25);
  const state = readPrivate<HostState>(statePath)!;
  expect(state.phase).toBe("launched");
  const base: Session = { id: "session", agentKind: "claude_code", sessionRef: state.sessionRef!, desiredSettings: { revision: 1, mode: "plan", planning: true } };
  for (const id of ["first-reply", "later-poll"]) {
    const failed = await hostCall(root, "settings", { ...base, command: { id, status: "delivering", text: "must not arrive" } });
    expect(failed.settingsError).toContain("confirm");
    expect(failed.commandStatus).toBe("failed");
    expect(failed.commandError).toContain("未发送");
  }
  const stop = await hostCall(root, "settings", { ...base, command: { id: "stop", kind: "interrupt", status: "delivering", text: "" } });
  expect(stop.commandStatus).toBe("delivered"); expect(stop.stopConfirmed).toBe(true);
  const recovered = await hostCall(root, "settings", { ...base, desiredSettings: { revision: 2, mode: "default", planning: false },
    command: { id: "new-reply", status: "delivering", text: "new explicit reply" } });
  expect(recovered.settingsError).toBeUndefined(); expect(recovered.commandStatus).toBe("delivered");
  const inputs = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(inputs.filter(x => x.type === "user" && ["first-reply", "later-poll"].includes(x.uuid))).toHaveLength(0);
  expect(inputs.filter(x => x.fixture === "received_user" && x.uuid === "new-reply")).toEqual([expect.objectContaining({ mode: "default" })]);
}, 15_000);
