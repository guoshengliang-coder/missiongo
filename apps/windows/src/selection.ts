import type { DesktopRequest } from "./contracts.js";

export interface BackendSelection<T extends BackendPort = BackendPort> { backend: T; bridgeCommand: string }
interface BackendPort { request(request: DesktopRequest): Promise<unknown>; close(): Promise<void> }
/** Keep the old runtime and its bridge together until the candidate is usable. */
export async function replaceBackend<T extends BackendPort>(current: BackendSelection | undefined, candidate: BackendSelection<T>): Promise<BackendSelection<T>> {
  try { await candidate.backend.request({ method: "snapshot" }); }
  catch (error) { await candidate.backend.close().catch(() => {}); throw error; }
  try { await current?.backend.close(); }
  catch (error) { await candidate.backend.close().catch(() => {}); throw error; }
  return candidate;
}

export function wslLaunch(distribution: string, executable: string, entry: string) {
  if (!executable.startsWith("/") || /[\r\n\0]/.test(executable) || executable.length > 4096) throw new Error("请填写 WSL 中 Node.js 的 Linux 绝对路径");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    args: ["--distribution", distribution, "--cd", "~", "--exec", executable, entry, "--worker"],
    bridgeCommand: `${quote(executable)} ${quote(entry)} _bridge --agent claude_code --cwd '<仓库 Linux 绝对路径>'`,
  };
}
