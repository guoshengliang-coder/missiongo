import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Wire } from "./types.js";
import { object } from "./types.js";

export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<string, { resolve: (v: Wire) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  onEvent: (event: Wire) => void = () => {};
  onClose: () => void = () => {};
  constructor(executable: string, args: string[], cwd: string) {
    this.child = spawn(executable, args, { cwd, env: process.env, stdio: "pipe" });
    this.child.stderr.resume(); // Model config and tool output must not enter node logs.
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 8 * 1024 * 1024) { this.child.kill(); return; }
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
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("Agent control channel closed")); }
      this.pending.clear(); this.onClose();
    };
    this.child.on("error", closed); this.child.on("exit", closed);
    this.child.stdin.on("error", closed);
  }
  write(value: unknown): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error("Agent input is closed");
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

export async function probe(executable: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...(cwd ? { cwd } : {}), env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Agent check timed out")); }, 10_000);
    child.stdout.on("data", (bytes: Buffer) => { text += bytes.toString(); if (text.length > 1024 * 1024) child.kill(); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Agent executable unavailable")); });
    child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(text.trim()); else reject(new Error("Agent check failed")); });
  });
}
