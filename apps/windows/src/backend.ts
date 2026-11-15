import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { DesktopEvent, DesktopRequest } from "./contracts.js";
import { windowsSystemExecutable } from "../../node/src/launch.js";

export async function windowsCommand(executable: string, args: string[], encoding: "utf8" | "utf16le" = "utf8"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable === "wsl.exe" ? windowsSystemExecutable("wsl.exe") : executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows 环境检查超时")); }, 15_000);
    child.stdout.on("data", (part: Buffer) => { size += part.length; if (size > 1024 * 1024) child.kill(); else chunks.push(part); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("无法启动 Windows 环境检查")); });
    child.once("exit", (code) => {
      clearTimeout(timer); if (code !== 0) reject(new Error("Windows 环境检查失败，请核对 WSL 和 Node.js 安装"));
      else resolve(Buffer.concat(chunks).toString(encoding).replaceAll("\0", "").trim());
    });
  });
}
export async function listWslDistributions(): Promise<string[]> {
  const text = await windowsCommand("wsl.exe", ["--list", "--quiet"], "utf16le");
  return text.split(/\r?\n/).map((name) => name.trim()).filter((name) => name && !/[\\/:\r\n\0]/.test(name));
}

export class DesktopBackend {
  private closed = false;
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  constructor(executable: string, args: string[], env: NodeJS.ProcessEnv, onEvent: (event: DesktopEvent) => void) {
    this.child = spawn(executable === "wsl.exe" ? windowsSystemExecutable("wsl.exe") : executable, args, { env, windowsHide: true, stdio: "pipe" });
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (line.length > 4 * 1024 * 1024) { this.child.kill(); return; }
      try {
        const message = JSON.parse(line);
        if (message.event && ["authorization", "status", "attention"].includes(message.event.type)) { onEvent(message.event); return; }
        const waiting = this.pending.get(String(message.id)); if (!waiting) return;
        this.pending.delete(String(message.id)); clearTimeout(waiting.timer);
        if (typeof message.error === "string") waiting.reject(new Error(message.error)); else waiting.resolve(message.value);
      } catch { /* Ignore runtime startup banners, never forward raw output. */ }
    });
    const closed = () => {
      this.closed = true;
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("执行环境已退出，请重新打开客户端；已有 Agent 会话不会被自动重建")); }
      this.pending.clear();
    };
    this.child.once("error", closed); this.child.once("exit", closed); this.child.stdin.on("error", closed);
  }
  request(request: DesktopRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("所选执行环境未启动，请在本机设置中重新选择并保存"));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("执行环境响应超时，请先核实结果，勿重复提交")); }, request.method === "login" ? 3_700_000 : 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, request }) + "\n", (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("执行环境输入通道已关闭")); } });
    });
  }
  async close(): Promise<void> {
    if (this.closed || this.child.exitCode !== null) return;
    await this.request({ method: "cancelLogin" }).catch(() => {});
    await this.request({ method: "run", enabled: false }).catch(() => {});
    this.child.stdin.end();
  }
}
