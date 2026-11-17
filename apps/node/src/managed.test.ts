import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "./api.js";
import * as host from "./host.js";
import { ManagedCoordinator, type ManagedEntry } from "./managed.js";
import { managedPolicy, validateManagedScope, validateManagedMcp, validateManagedVersion, type ManagedJob } from "./managed-policy.js";
import { loadConfig, readPrivate, saveConfig, savePrivate } from "./storage.js";
import { CodexAdapter } from "./codex.js";

const roots: string[] = [];
const adapters: CodexAdapter[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-managed-"))); roots.push(root);
  const job: ManagedJob = { enabled: true, repoPath: root, taskContext: "untrusted task", intent: { id: "intent-1", stageId: "stage-1", generation: 1, state: "requested", ownershipHeld: true, stopRequested: false,
    binding: { runId: "run-1", decisionId: "decision-1", version: 1, stateVersion: 1, contentDigest: "a".repeat(64), scopeDigest: "b".repeat(64), contractRevision: 1, idempotencyKey: "key", stageKey: "implement", role: "implement", inputCommit: "c".repeat(40), nodeId: "node-1", permissionMode: "workspace-write" } } };
  saveConfig(root, { ...loadConfig(root), nodeId: "node-1", managedExecutionEnabled: true, agents: { codex: {} } });
  return { root, job, path: join(root, "managed-journal", "intent-1.json") };
}
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

it.each([false, true])("native protocol preparation never sends a first turn before a separate start (live MCP: %s)", async (liveMcp) => {
  const { job, root } = fixture(); const log = join(root, "native-events");
  vi.stubEnv("FAKE_MANAGED", "1"); vi.stubEnv("TEST_AGENT_EVENTS", log); if (liveMcp) vi.stubEnv("FAKE_LIVE_MCP", "1");
  const executable = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url)); chmodSync(executable, 0o755);
  const adapter = new CodexAdapter({ dispatchId: "managed", repoPath: root, itemKeys: [], freeSession: true, agentKind: "codex", mode: "default" }, executable); adapters.push(adapter);
  if (liveMcp) await expect(adapter.prepareManaged(job)).rejects.toThrow("isolation");
  else expect(await adapter.prepareManaged(job)).toMatchObject({ sessionRef: "thread-1", resolvedModel: "fixture-managed-model", cwd: root });
  expect(readFileSync(log, "utf8")).not.toContain('"method":"turn/start"');
  if (!liveMcp) {
    await adapter.startManagedTurn();
    const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const turns = events.filter((event) => event.method === "turn/start");
    await adapter.stopManagedTurn();
    const afterStop=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(afterStop.filter(event=>event.method === "thread/read").every(event=>event.params.includeTurns === false)).toBe(true);
    expect(afterStop.some(event=>event.method === "thread/turns/items/list")).toBe(false);
    expect(turns).toHaveLength(1); expect(turns[0].params).toMatchObject({ threadId: "thread-1", model: "fixture-managed-model", approvalsReviewer: "user" });
    await expect(adapter.retryApproval({ id: "retry", reviewId: "review", status: "queued" })).rejects.toThrow("frozen");
  }
});

it("rejects expanded runtime roots, reviewer writes, live MCP tools and a mismatched native protocol", () => {
  const { job, root } = fixture();
  const result = { ...managedPolicy("implement"), cwd: root, runtimeWorkspaceRoots: [root], sandbox: { type: "workspaceWrite", writableRoots: [root] } };
  expect(() => validateManagedScope(result, job, root)).not.toThrow();
  expect(() => validateManagedScope({ ...result, runtimeWorkspaceRoots: [root, tmpdir()] }, job, root)).toThrow();
  expect(() => validateManagedScope(result, { ...job, intent: { ...job.intent, binding: { ...job.intent.binding, role: "review", permissionMode: "read-only" } } }, root)).toThrow();
  expect(() => validateManagedMcp({ data: [{ runtimeStatus: "disabled", tools: {} }] })).not.toThrow();
  expect(() => validateManagedMcp({ data: [{ runtimeStatus: "connected", tools: { claim_item: {} } }] })).toThrow();
  expect(() => validateManagedMcp({ data: [], nextCursor: "more" })).toThrow();
  expect(() => validateManagedVersion({ userAgent: "codex/0.155.0-alpha.16.3 Windows" })).not.toThrow();
  expect(() => validateManagedVersion({ userAgent: "codex/0.155.0" })).toThrow();
});

it.each(["launching", "turnPermitPending", "turnStarting"])("reconciles a crashed %s journal without issuing another launch or first-turn permit", async (phase) => {
  const { job, root, path } = fixture();
  savePrivate(path, { job, phase, nextSequence: 1 });
  const call = vi.fn(async (_method: string, route: string, body: unknown) => {
    expect(route).toBe("/api/v1/node/managed-execution/intent-1/report"); expect(body).toMatchObject({ state: "unknown", sequence: 1, generation: 1 });
    return { accepted: true };
  });
  await new ManagedCoordinator(root, "never-spawn", { call } as unknown as API).process(job, new AbortController().signal);
  expect(call).toHaveBeenCalledOnce(); expect(readPrivate<ManagedEntry>(path)).toMatchObject({ phase: "unknown", nextSequence: 2 });
});

it("persists first-turn uncertainty before the permit request and refuses to retry it after a lost response", async () => {
  const { job, root, path } = fixture();
  savePrivate(path, { job, phase: "bound", nextSequence: 2, receipt: { cwd: root, sessionRef: "original", resolvedModel: "frozen-model" } });
  const call = vi.fn(async (_method: string, route: string) => {
    expect(route.endsWith("/permit")).toBe(true); expect(readPrivate<ManagedEntry>(path)?.phase).toBe("turnPermitPending"); throw new Error("response lost");
  });
  const coordinator = new ManagedCoordinator(root, "never-spawn", { call } as unknown as API);
  await expect(coordinator.process(job, new AbortController().signal)).rejects.toThrow("response lost");
  call.mockImplementation(async (_method, route) => { expect(route.endsWith("/report")).toBe(true); return { accepted: true } as never; });
  await coordinator.process(job, new AbortController().signal);
  expect(call).toHaveBeenCalledTimes(2); expect(readPrivate<ManagedEntry>(path)?.phase).toBe("unknown");
});

it("ignores new work while disabled and rejects a terminal receipt for another generation", async () => {
  const { job, root } = fixture(); saveConfig(root, { ...loadConfig(root), managedExecutionEnabled: false });
  const call = vi.fn(async () => ({ accepted: true, terminal: { state: "terminal", intentId: job.intent.id, generation: 2, sequence: 1 } }));
  const coordinator = new ManagedCoordinator(root, "never-spawn", { call } as unknown as API);
  await coordinator.process(job, new AbortController().signal); expect(call).not.toHaveBeenCalled();
  const entry: ManagedEntry = { job, phase: "unknown", nextSequence: 1, pending: { sequence: 1, generation: 1, state: "unknown" } };
  await expect(coordinator.flush(entry)).rejects.toThrow("binding differed"); expect(entry.nextSequence).toBe(1); expect(entry.pending).toBeDefined();
});

it("observation and history stay read-only even when the managed binding requests a stop", async () => {
  const {job,root,path}=fixture();
  savePrivate(path,{job,phase:"running",nextSequence:3,receipt:{cwd:root,sessionRef:"native",resolvedModel:"frozen"}});
  const before=readFileSync(path,"utf8");
  const sync=vi.spyOn(host,"hostCall").mockResolvedValue({status:"active",messages:[]});
  const history=vi.spyOn(host,"hostHistoryCall").mockResolvedValue({messages:[]});
  const call=vi.fn(); const coordinator=new ManagedCoordinator(root,"never-spawn",{call} as unknown as API);
  const session={id:"session",agentKind:"codex" as const,sessionRef:"native",managedExecution:{id:job.intent.id,generation:1,stageId:job.intent.stageId,runId:job.intent.binding.runId,role:job.intent.binding.role,state:"running",stopRequested:true}};
  await coordinator.synchronize(session,new AbortController().signal,true);
  expect(sync).toHaveBeenCalledWith(root,"managed-intent-1",expect.anything(),"observation");
  await coordinator.historyPage(session,"cursor"); expect(history).toHaveBeenCalledExactlyOnceWith(root,"managed-intent-1","native","cursor");
  expect(call).not.toHaveBeenCalled();expect(readFileSync(path,"utf8")).toBe(before);
  await expect(coordinator.historyPage({...session,managedExecution:{...session.managedExecution,generation:2}},"cursor")).rejects.toThrow("identity");
  expect(history).toHaveBeenCalledOnce();
});
