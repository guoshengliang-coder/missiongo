import { createServer, type Server } from "node:net";
import { createHash } from "node:crypto";

/** Kernel-owned lease. No stale PID files and no deletion of another owner's lock. */
export async function acquireNodeLease(root: string): Promise<() => Promise<void>> {
  const name = `\\\\.\\pipe\\missiongo-node-${createHash("sha256").update(root).digest("hex")}`;
  const server: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("Another node is using this Windows configuration")));
    server.listen(name, () => resolve());
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
