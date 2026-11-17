import { expect, it, vi } from "vitest";
import { replaceBackend, wslLaunch } from "./selection.js";

it("keeps the active runtime and copied bridge command together after a failed switch", async () => {
  const original = { backend: { request: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined) }, bridgeCommand: "native bridge" };
  const replacement = { backend: { request: vi.fn().mockRejectedValue(new Error("WSL Node missing")), close: vi.fn().mockResolvedValue(undefined) }, bridgeCommand: "wsl bridge" };
  let active = original;
  await expect((async () => { active = await replaceBackend(active, replacement); })()).rejects.toThrow("WSL Node missing");
  expect(active).toBe(original); expect(active.bridgeCommand).toBe("native bridge");
  expect(original.backend.close).not.toHaveBeenCalled(); expect(replacement.backend.close).toHaveBeenCalledOnce();
  replacement.backend.request.mockResolvedValue({});
  active = await replaceBackend(active, replacement);
  expect(active).toBe(replacement); expect(original.backend.close).toHaveBeenCalledOnce();
});
it("uses the explicit nvm Node path for WSL workers and terminal bridges without loading a shell", () => {
  const node = "/home/fixture/.nvm/versions/node/v22.13.0/bin/node";
  const entry = "/mnt/c/user's files/worker.mjs";
  const launch = wslLaunch("Ubuntu", node, entry);
  expect(launch.args).toEqual(["--distribution", "Ubuntu", "--cd", "~", "--exec", node, entry, "--worker"]);
  expect(launch.bridgeCommand).toContain(`'${node}'`); expect(launch.bridgeCommand).toContain("user'\\''s files");
  for (const invalid of ["node", "~/node", "C:\\node.exe", "/usr/bin/node\n--help"]) expect(() => wslLaunch("Ubuntu", invalid, entry)).toThrow("Linux 绝对路径");
});

it("rejects a candidate cleanup failure without replacing the original bridge", async () => {
  const current = { backend: { request: vi.fn(), close: vi.fn() }, bridgeCommand: "original" };
  const candidate = { backend: { request: vi.fn().mockRejectedValue(new Error("snapshot failed")), close: vi.fn().mockRejectedValue(new Error("cleanup failed")) }, bridgeCommand: "candidate" };
  await expect(replaceBackend(current, candidate)).rejects.toThrow("snapshot failed"); expect(current.backend.close).not.toHaveBeenCalled();
});
