import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnAgent, killProcessTree, agentEnvironment } from "./launch.js";
import { StringDecoder } from "node:string_decoder";
import type { Wire } from "./types.js";
import { object } from "./types.js";

export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private closed = false;
  private pending = new Map<string, { resolve: (v: Wire) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  onEvent: (event: Wire) => void = () => {};
  onClose: () => void = () => {};
  constructor(executable: string, args: string[], cwd: string, env = process.env) {
    this.child = spawnAgent(executable, args, { cwd, env, detached: true, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
    this.child.stderr.resume(); // Model config and tool output must not enter node logs.
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 32 * 1024 * 1024) { this.child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = object(JSON.parse(line));
          const waiting = event.id !== undefined ? this.pending.get(String(event.id)) : undefined;
          if (waiting && (event.result !== undefined || event.error !== undefined)) {
            this.pending.delete(String(event.id)); clearTimeout(waiting.timer);
            if (event.error) waiting.reject(new Error("Agent rejected protocol request"));
            else waiting.resolve(object(event.result ?? {}));
          } else this.onEvent(event);
        } catch { /* Ignore banners, not a replacement for a successful handshake. */ }
      }
    });
    const closed = () => {
      if (this.closed) return;
      this.closed = true;
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("Agent control channel closed")); }
      this.pending.clear(); this.onClose();
    };
    this.child.on("error", closed); this.child.on("exit", closed);
    this.child.stdin.on("error", closed);
  }
  close(): void { if (this.child.exitCode === null && this.child.signalCode === null) killProcessTree(this.child.pid); }
  write(value: unknown): void {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error("Agent input is closed");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  call(method: string, params: unknown = {}, timeout = 60_000): Promise<Wire> {
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Agent protocol timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}

export async function probe(executable: string, args: string[], cwd?: string, env = agentEnvironment(), timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnAgent(executable, args, { ...(cwd ? { cwd } : {}), env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Agent version check timed out"), timeoutMs);
    child.stdout!.on("data", (bytes: Buffer) => {
      if (settled) return;
      if (text.length + bytes.length > 1024 * 1024) { fail("Agent version check output exceeded the limit"); return; }
      text += bytes.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? "Agent executable not found; check PATH, Node runtime or launcher" : "Agent executable could not be started; check permissions and launcher"));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) { fail(`Agent version check failed (${signal ? `signal ${signal}` : `exit ${code}`}); check Node runtime and launcher`); return; }
      settled = true; clearTimeout(timer); resolve(text.trim());
    });
  });
}
