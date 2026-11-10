import { expect, it, vi } from "vitest";
import { SessionSender, SendUnconfirmed } from "./session-send";
import { ApiError } from "./api";
import type { AgentSessionCommand } from "./types";

const command: AgentSessionCommand = { id: "original", kind: "message", text: "do work", status: "queued", createdAt: "2026-11-10T00:00:00Z" };
function fixture() {
  const transport = {
    sendAgentSessionCommand: vi.fn().mockResolvedValue(command),
    getAgentSendRequest: vi.fn().mockResolvedValue({ command: null }),
    uploadAgentSessionAttachment: vi.fn().mockResolvedValue({ id: "file-one" }),
  };
  const sender = new SessionSender(transport);
  const input = { sessionId: "session", text: "do work", files: [] as File[], occurredAt: command.createdAt };
  return { sender, transport, input };
}
it("synchronously deduplicates double click but lets a deliberate later same-text send use a new key", async () => {
  const f = fixture();
  const first = f.sender.send(f.input);
  expect(f.sender.send(f.input)).toBe(first);
  await first;
  await f.sender.send(f.input);
  expect(f.transport.sendAgentSessionCommand).toHaveBeenCalledTimes(2);
  expect(f.transport.sendAgentSessionCommand.mock.calls[0]![3]).not.toBe(f.transport.sendAgentSessionCommand.mock.calls[1]![3]);
});
it("recovers a committed POST whose response was lost without another POST or attachment cleanup", async () => {
  const f = fixture();
  f.transport.sendAgentSessionCommand.mockRejectedValue(new TypeError("response lost"));
  f.transport.getAgentSendRequest.mockResolvedValue({ command });
  expect(await f.sender.send(f.input)).toBe(command);
  expect(f.transport.sendAgentSessionCommand).toHaveBeenCalledTimes(1);
  expect(f.sender.get("session")?.phase).toBe("sent");
});
it("unknown results only read; explicit retry uses the frozen original key and payload", async () => {
  const f = fixture();
  f.transport.sendAgentSessionCommand.mockRejectedValueOnce(new TypeError("timeout"));
  await expect(f.sender.send(f.input)).rejects.toBeInstanceOf(SendUnconfirmed);
  const key = f.sender.get("session")!.requestKey;
  await expect(f.sender.send({ ...f.input, text: "changed" })).rejects.toBeInstanceOf(SendUnconfirmed);
  expect(f.transport.sendAgentSessionCommand).toHaveBeenCalledTimes(1);
  await f.sender.send({ ...f.input, text: "changed", recovery: "retry" });
  expect(f.transport.sendAgentSessionCommand.mock.calls[1]).toEqual(["session", "do work", [], key]);
});
it("does not retry POST when result lookup fails (including old servers)", async () => {
  const f = fixture();
  f.transport.sendAgentSessionCommand.mockRejectedValue(new TypeError("timeout"));
  f.transport.getAgentSendRequest.mockRejectedValue(new ApiError(404, "not_found", "Old server"));
  await expect(f.sender.send(f.input)).rejects.toBeInstanceOf(SendUnconfirmed);
  await expect(f.sender.send({ ...f.input, recovery: "retry" })).rejects.toBeInstanceOf(SendUnconfirmed);
  expect(f.transport.sendAgentSessionCommand).toHaveBeenCalledTimes(1);
});
it("partial upload failure retains confirmed IDs and reuses the failed file's upload key", async () => {
  const f = fixture();
  const input = { ...f.input, files: [new File(["a"], "a.txt"), new File(["b"], "b.txt")] };
  f.transport.uploadAgentSessionAttachment.mockResolvedValueOnce({ id: "a" }).mockRejectedValueOnce(new TypeError("lost upload response"))
    .mockResolvedValueOnce({ id: "b" });
  await expect(f.sender.send(input)).rejects.toThrow("lost upload response");
  const key = f.sender.get("session")!.requestKey;
  await f.sender.send(input);
  expect(f.transport.uploadAgentSessionAttachment.mock.calls.map(call => call[2])).toEqual([`${key}-0`, `${key}-1`, `${key}-1`]);
  expect(f.transport.sendAgentSessionCommand.mock.calls[0]![2]).toEqual(["a", "b"]);
});
it("late completion after page draft clear cannot recreate a cleared attempt", async () => {
  const f = fixture();
  let resolve!: (command: AgentSessionCommand) => void;
  f.transport.sendAgentSessionCommand.mockImplementation(() => new Promise(done => { resolve = done; }));
  const result = f.sender.send(f.input);
  await Promise.resolve();
  f.sender.clear(); resolve(command); await result;
  expect(f.sender.get("session")).toBeUndefined();
});
it("a definite validation rejection permits editing and a different request", async () => {
  const f = fixture();
  f.transport.sendAgentSessionCommand.mockRejectedValueOnce(new ApiError(400, "invalid_input", "Invalid"));
  await expect(f.sender.send(f.input)).rejects.toBeInstanceOf(ApiError);
  const key = f.sender.get("session")!.requestKey;
  await f.sender.send({ ...f.input, text: "corrected" });
  expect(f.sender.get("session")!.requestKey).not.toBe(key);
});
