import { spawnAgent, killProcessTree, agentEnvironment } from "./launch.js";

export interface CommandResult { code: number; stdout: string }
export type FixedCommand = (file: "git" | "gh" | "glab", args: string[], cwd: string) => Promise<CommandResult>;
/** Internal fixed domain operations only; never exposed as a generic IPC tool. */
export const fixedCommand: FixedCommand = (file, args, cwd) => new Promise((resolve) => {
  const child = spawnAgent(file, args, { cwd, env: agentEnvironment(), detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = []; let size = 0; let ended = false;
  const finish = (code: number) => { if (ended) return; ended = true; clearTimeout(timer); resolve({ code, stdout: code === -1 ? "" : Buffer.concat(chunks).toString("utf8").trim() }); };
  const timer = setTimeout(() => { killProcessTree(child.pid); finish(-1); }, 20_000);
  child.stdout!.on("data", (part: Buffer) => { size += part.length; if (size > 4 * 1024 * 1024) { killProcessTree(child.pid); finish(-1); } else chunks.push(part); });
  child.once("error", () => finish(-1)); child.once("close", (code) => finish(code ?? -1));
});
