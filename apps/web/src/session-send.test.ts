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
  f.sender.clear(); resolve(command); await expect(result).rejects.toThrow();
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
it("audit R1: clearing before the first microtask prevents any request", async () => {
  const f = fixture();
  const result = f.sender.send(f.input);
  f.sender.clear();
  await expect(result).rejects.toThrow();
  expect(f.transport.sendAgentSessionCommand).not.toHaveBeenCalled();
});
it("audit R1: clearing during upload prevents the following command submission", async () => {
  const f = fixture();
  let resolve!: (value: { id: string }) => void;
  f.transport.uploadAgentSessionAttachment.mockImplementation(() => new Promise(done => { resolve = done; }));
  const result = f.sender.send({ ...f.input, files: [new File(["a"], "a.txt")] });
  await Promise.resolve();
  f.sender.clear(); resolve({ id: "old-upload" });
  await expect(result).rejects.toThrow();
  expect(f.transport.sendAgentSessionCommand).not.toHaveBeenCalled();
});
it("audit R1: explicit recovery from another surface retains a failed attempt's files", async () => {
  const f = fixture();
  const input = { ...f.input, files: [new File(["a"], "a.txt")] };
  f.transport.uploadAgentSessionAttachment.mockRejectedValueOnce(new TypeError("upload failed"));
  await expect(f.sender.send(input)).rejects.toThrow();
  const key = f.sender.get("session")!.requestKey;
  await f.sender.send({ ...f.input, recovery: "retry" });
  expect(f.transport.uploadAgentSessionAttachment.mock.calls[1]![2]).toBe(`${key}-0`);
  expect(f.transport.sendAgentSessionCommand.mock.calls[0]![2]).toEqual(["file-one"]);
});

it("audit R1: a delayed recovery click after success cannot create a new request", async () => {
  const f = fixture(); await f.sender.send(f.input);
  await f.sender.send({ ...f.input, recovery: "retry" });
  expect(f.transport.sendAgentSessionCommand).toHaveBeenCalledTimes(1);
});
it.each(["cancelled", "failed"] as const)("audit R2: recovering a %s command keeps its draft and cannot count as delivered", async status => {
  const f = fixture(), settled = vi.fn();
  const sender = new SessionSender(f.transport, settled);
  const file = new File(["a"], "a.txt"), input = { ...f.input, files: [file] };
  f.transport.sendAgentSessionCommand.mockRejectedValueOnce(new TypeError("ack lost"));
  f.transport.getAgentSendRequest.mockResolvedValue({ command: { ...command, status } });
  expect((await sender.send(input)).status).toBe(status);
  expect(settled).not.toHaveBeenCalled();
  expect(sender.get("session")?.files).toEqual([file]);
  const originalKey = sender.get("session")!.requestKey;
  await sender.send(input); // a deliberate new send, not an automatic recovery
  expect(f.transport.sendAgentSessionCommand.mock.calls[1]![3]).not.toBe(originalKey);
});

it("audit R3: a recovery action cannot create a request after its attempt is cleared", async () => {
  const f = fixture(); await f.sender.send(f.input);
  const previous = f.sender.get("session")!;
  f.sender.clear();
  await expect(f.sender.send({ ...previous, recovery: "retry" })).rejects.toThrow();
  expect(f.transport.sendAgentSessionCommand).toHaveBeenCalledTimes(1);
});
it("audit R3: a stale recovery action cannot act on a later attempt in that session", async () => {
  const f = fixture(); await f.sender.send(f.input);
  const previous = f.sender.get("session")!;
  f.transport.sendAgentSessionCommand.mockRejectedValueOnce(new TypeError("timeout"));
  await expect(f.sender.send({ ...f.input, text: "new request" })).rejects.toBeInstanceOf(SendUnconfirmed);
  await expect(f.sender.send({ ...previous, recovery: "retry" })).rejects.toThrow();
  expect(f.transport.sendAgentSessionCommand).toHaveBeenCalledTimes(2);
});
