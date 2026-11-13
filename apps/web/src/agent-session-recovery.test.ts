import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { api, ApiError } from "./api";
import { clearDeniedSession, recoverAgentSession } from "./agent-session-recovery";
import type { AgentSessionSummary } from "./types";

const clients: QueryClient[] = [];
function client() { const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(c); return c; }
afterEach(() => { vi.restoreAllMocks(); clients.splice(0).forEach(c => c.clear()); });
const row = { id: "canonical", relatedSessionIds: ["legacy"] } as unknown as AgentSessionSummary;

test("fresh list identity mapping resolves without probing an old ID", async () => {
  vi.spyOn(api, "listAgentSessions").mockResolvedValue({ sessions: [row] });
  const detail = vi.spyOn(api, "getAgentSession");
  expect(await recoverAgentSession(client(), "legacy", new AbortController().signal)).toEqual({ kind: "ready" });
  expect(detail).not.toHaveBeenCalled();
});

test("successful detail is followed by exactly one list read and never invents a summary", async () => {
  const c = client();
  const list = vi.spyOn(api, "listAgentSessions").mockResolvedValue({ sessions: [] });
  const detail = vi.spyOn(api, "getAgentSession").mockResolvedValue({ id: "legacy", messages: [] } as never);
  expect(await recoverAgentSession(c, "legacy", new AbortController().signal)).toEqual({ kind: "sync_pending" });
  expect(list).toHaveBeenCalledTimes(2); expect(detail).toHaveBeenCalledTimes(1);
  expect(c.getQueryData(["agent-sessions"])).toEqual({ sessions: [] });
  expect(c.getQueryData(["agent-session", "legacy"])).toBeUndefined();
});

test("a mapping delivered after the detail check restores the target", async () => {
  vi.spyOn(api, "listAgentSessions").mockResolvedValueOnce({ sessions: [] }).mockResolvedValueOnce({ sessions: [row] });
  vi.spyOn(api, "getAgentSession").mockResolvedValue({ id: "legacy", messages: [] } as never);
  expect(await recoverAgentSession(client(), "legacy", new AbortController().signal)).toEqual({ kind: "ready" });
});

for (const status of [401, 403, 404]) test(`confirmed ${status} clears denied content but preserves other sessions`, async () => {
  const c = client(), error = new ApiError(status, "access", "private detail");
  c.setQueryData(["agent-session", "legacy"], { messages: ["secret"] });
  c.setQueryData(["artifact-bundle", "legacy", "a"], { secret: true });
  c.setQueryData(["agent-session", "other"], { messages: ["keep"] });
  vi.spyOn(api, "listAgentSessions").mockResolvedValue({ sessions: [] });
  vi.spyOn(api, "getAgentSession").mockRejectedValue(error);
  expect(await recoverAgentSession(c, "legacy", new AbortController().signal)).toEqual({ kind: "unavailable", error });
  expect(c.getQueryData(["agent-session", "legacy"])).toBeUndefined();
  expect(c.getQueryData(["artifact-bundle", "legacy", "a"])).toBeUndefined();
  expect(c.getQueryData(["agent-session", "other"])).toEqual({ messages: ["keep"] });
});

test("temporary failure is retryable and does not erase cached content", async () => {
  const c = client(), error = new ApiError(503, "unavailable", "Service unavailable");
  c.setQueryData(["agent-session", "legacy"], { messages: ["keep"] });
  vi.spyOn(api, "listAgentSessions").mockResolvedValue({ sessions: [] });
  vi.spyOn(api, "getAgentSession").mockRejectedValue(error);
  await expect(recoverAgentSession(c, "legacy", new AbortController().signal)).rejects.toBe(error);
  expect(c.getQueryData(["agent-session", "legacy"])).toEqual({ messages: ["keep"] });
});

test("abandoned recovery cannot apply a late denial to a newer snapshot", async () => {
  const c = client(), controller = new AbortController();
  vi.spyOn(api, "listAgentSessions").mockResolvedValue({ sessions: [] });
  vi.spyOn(api, "getAgentSession").mockImplementation(async () => {
    controller.abort(); c.setQueryData(["agent-session", "legacy"], { messages: ["new"] });
    throw new ApiError(404, "not_found", "late");
  });
  await expect(recoverAgentSession(c, "legacy", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(c.getQueryData(["agent-session", "legacy"])).toEqual({ messages: ["new"] });
});

test("clearing an observed denied detail retains its error for stable retry UI", () => {
  const c = client(), error = new ApiError(403, "forbidden", "forbidden");
  c.setQueryData(["agent-session", "legacy"], { messages: ["secret"] });
  c.getQueryCache().find({ queryKey: ["agent-session", "legacy"] })!.setState({ status: "error", error });
  clearDeniedSession(c, "legacy");
  expect(c.getQueryState(["agent-session", "legacy"])).toMatchObject({ status: "error", error, data: undefined });
});
