import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexTurnFailure } from "./codex-failure.js";
import { CodexAdapter } from "./codex.js";
import type { Wire } from "./types.js";

it.each([
  ["contextWindowExceeded", "codex_context_window_exceeded"], ["sessionBudgetExceeded", "codex_session_budget_exceeded"],
  ["usageLimitExceeded", "codex_usage_limit_exceeded"], ["rateLimitExceeded", "codex_rate_limit_exceeded"],
  ["unauthorized", "codex_unauthorized"], ["internalServerError", "codex_server_error"],
  ["serverOverloaded", "codex_server_error"], ["flexUnavailable", "codex_server_error"],
  ["badRequest", "codex_bad_request"], ["sandboxError", "codex_sandbox_error"],
  ["cyberPolicy", "codex_policy_denied"], ["misalignmentPolicyViolation", "codex_policy_denied"],
  ["tooManyDenials", "codex_policy_denied"], ["futureVariant", "codex_turn_failed"],
  ["constructor", "codex_turn_failed"],
])("maps public %s without classifying message text", (type, code) => {
  expect(codexTurnFailure({ id: "t1", error: { codexErrorInfo: type, message: "network sandbox rate limit" } }))
    .toEqual({ code, turnId: "t1", detail: "network sandbox rate limit" });
});

for (const type of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
  it.each([[401, "codex_unauthorized"], [403, "codex_unauthorized"], [429, "codex_rate_limit_exceeded"],
    [502, "codex_server_error"], [null, "codex_connection_failed"], [200, "codex_connection_failed"]])("maps %s for " + type, (status, code) => {
    const failure = codexTurnFailure({ error: { codexErrorInfo: { [type]: { httpStatusCode: status } } } });
    expect(failure?.code).toBe(code);
    expect(failure?.httpStatusCode).toBe(typeof status === "number" && status >= 400 ? status : undefined);
  });
}

it("keeps missing details honest and only exports bounded, redacted public fields", () => {
  for (const error of [null, undefined, "plain", [], {}, { message: "  " }]) expect(codexTurnFailure({ error })).toBeUndefined();
  const failure = codexTurnFailure({ id: "unsafe/path", error: { message: "token=synthetic-secret https://example.invalid/private /tmp/private/data " + "x".repeat(3000),
    codexErrorInfo: "other", additionalDetails: "hidden-diagnostic", misalignment: { hidden: "private" } } })!;
  expect(failure.code).toBe("codex_turn_failed");
  expect(failure.turnId).toBeUndefined();
  expect(failure.detail!.length).toBeLessThanOrEqual(2000);
  for (const secret of ["synthetic-secret", "example.invalid", "/tmp/private", "hidden-diagnostic", "misalignment"]) expect(JSON.stringify(failure)).not.toContain(secret);
  expect(codexTurnFailure({ error: { message: "Unknown error" } })?.code).toBe("codex_turn_failed");
});

const adapters: CodexAdapter[] = [], roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const adapter of adapters.splice(0)) await adapter.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("reports metadata and terminal events in both snapshot lanes, clears on recovery, and never replays input", async () => {
  const root = mkdtempSync(join(tmpdir(), "mg-failure-")); roots.push(root);
  const executable = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url)); chmodSync(executable, 0o755);
  const adapter = new CodexAdapter({ dispatchId: "fixture", itemKeys: [], freeSession: true, agentKind: "codex", repoPath: root, mode: "auto" }, executable);
  adapters.push(adapter);
  await adapter.start("failure metadata fixture");
  const observe = async () => {
    const control = await adapter.controlSnapshot(), mirror = await adapter.snapshot();
    expect(control.status).toBe("failed");
    expect(control.failure).toEqual(mirror.failure);
    expect(control.failure).toMatchObject({ code: "codex_server_error", httpStatusCode: 502 });
    for (const secret of ["fixture-secret", "/tmp/private", "must-not-upload"]) expect(JSON.stringify(mirror.failure)).not.toContain(secret);
    return mirror;
  };
  const initial = await observe();
  expect((await observe()).messages).toEqual(initial.messages);
  await adapter.deliver({ id: "event", status: "delivering", text: "failure event fixture" });
  expect((await observe()).failure?.turnId).toBe("turn-failure-event-fixture");
  await adapter.deliver({ id: "missing", status: "delivering", text: "failure missing fixture" });
  expect((await adapter.snapshot()).failure).toBeUndefined(); // No reuse of another turn's event.
  await adapter.deliver({ id: "transient", status: "delivering", text: "transient fixture" });
  expect(await adapter.controlSnapshot()).toMatchObject({ status: "active", failure: undefined });
  await adapter.deliver({ id: "recovery", status: "delivering", text: "recovery fixture" });
  expect(await adapter.snapshot()).toMatchObject({ status: "idle", failure: undefined });
  expect((await adapter.controlSnapshot()).failure).toBeUndefined();
});

it("a slow pre-failure mirror cannot erase the terminal event needed by later controls", async () => {
  const root = mkdtempSync(join(tmpdir(), "mg-failure-race-")); roots.push(root);
  const executable = fileURLToPath(new URL("./fixtures/agent.cjs", import.meta.url)); chmodSync(executable, 0o755);
  const adapter = new CodexAdapter({ dispatchId: "race", itemKeys: [], freeSession: true, agentKind: "codex", repoPath: root, mode: "auto" }, executable);
  adapters.push(adapter);
  await adapter.start("transient fixture");
  const rpc = (adapter as unknown as { rpc: { call(method: string, params?: unknown): Promise<Wire> } }).rpc;
  const original = rpc.call.bind(rpc);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Wire>();
  vi.spyOn(rpc, "call").mockImplementation((method, params) => {
    if (method === "thread/items/list") { entered.resolve(); return release.promise; }
    return original(method, params);
  });
  const oldMirror = adapter.snapshot();
  try {
    await entered.promise;
    await adapter.deliver({ id: "fail-during-history", status: "delivering", text: "failure event fixture" });
    expect((await adapter.controlSnapshot()).failure?.code).toBe("codex_server_error");
  } finally { release.resolve({ data: [], nextCursor: null }); }
  expect((await oldMirror).status).toBe("active");
  expect((await adapter.controlSnapshot()).failure).toMatchObject({ code: "codex_server_error", turnId: "turn-failure-event-fixture" });
});
