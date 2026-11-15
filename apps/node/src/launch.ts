import crossSpawn from "cross-spawn";
import { spawnSync, type SpawnOptions, type ChildProcess } from "node:child_process";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, isAbsolute, extname, win32, dirname } from "node:path";

/** Also applies after an explicit environment script: cmd's implicit cwd lookup
 * must not let an npm shim load a repository's node.exe. */
export function safeWindowsEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  for (const key of Object.keys(env)) {
    if ((key !== pathKey && key.toLowerCase() === "path") || key.toLowerCase() === "nodefaultcurrentdirectoryinexepath") delete env[key];
  }
  env[pathKey] = (env[pathKey] ?? "").split(";").map((part) => part.replace(/^"|"$/g, "")).filter((part) => win32.isAbsolute(part) && !/^[/\\](?![/\\])/.test(part)).join(";");
  env.NoDefaultCurrentDirectoryInExePath = "1";
  return env;
}

/** Resolve shims with the same environment for probing and actual execution.
 * cross-spawn handles Windows PATHEXT, npm .cmd shims and argument escaping;
 * callers always provide argv, never command text or shell:true.
 */
export function agentEnvironment(base = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const env = { ...base };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  for (const key of Object.keys(env)) if (key !== pathKey && key.toLowerCase() === "path") delete env[key];
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir();
  const defaults = platform === "win32" ? [
    dirname(process.execPath), join(home, ".local", "bin"), join(home, ".volta", "bin"), join(home, "scoop", "shims"),
    ...(env.APPDATA ? [join(env.APPDATA, "npm")] : []), ...(env.NVM_SYMLINK ? [env.NVM_SYMLINK] : []),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"), join(env.LOCALAPPDATA, "Microsoft", "WindowsApps")] : []),
    ...(env.ProgramFiles ? [join(env.ProgramFiles, "nodejs"), join(env.ProgramFiles, "Git", "cmd"), join(env.ProgramFiles, "GitHub CLI")] : []),
    ...(env.SystemRoot ? [join(env.SystemRoot, "System32"), join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")] : []),
  ] : [dirname(process.execPath), join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"];
  const separator = platform === "win32" ? ";" : delimiter;
  env[pathKey] = [...new Set([...(env[pathKey] ?? "").split(separator).filter(Boolean), ...defaults.filter(existsSync)])].join(separator);
  return platform === "win32" ? safeWindowsEnvironment(env) : env;
}

export function spawnAgent(executable: string, args: readonly string[], options: SpawnOptions = {}, interpreterDepth = 0): ChildProcess {
  if (interpreterDepth > 4) throw new Error("Agent launcher interpreter chain is too deep");
  if (!executable || /[\r\n\0]/.test(executable) || args.some((arg) => arg.includes("\0"))) throw new Error("Invalid Agent executable or argument");
  // cross-spawn's Windows lookup also searches cwd. Resolve named launchers
  // against absolute PATH entries first so a repository cannot shadow them.
  const env = process.platform === "win32" ? safeWindowsEnvironment(options.env ?? process.env) : options.env ?? process.env;
  if (process.platform === "win32" && !isAbsolute(executable)) {
    if (/[\\/]/.test(executable)) throw new Error("Agent launchers must be absolute paths or PATH names");
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const extensions = extname(executable) ? [""] : [".exe", ".cmd", ".bat", ".com"];
    const found = (env[pathKey] ?? "").split(";").map((path) => path.replace(/^"|"$/g, "")).filter(isAbsolute)
      .flatMap((path) => extensions.map((extension) => join(path, executable + extension))).find((path) => { try { return statSync(path).isFile(); } catch { return false; } });
    if (!found) throw new Error("Agent executable not found in PATH or known installation directories");
    executable = found;
  }
  if (process.platform === "win32" && /\.cmd$|\.bat$/i.test(executable) && options.cwd && String(options.cwd).startsWith("\\\\")) throw new Error("UNC repositories require a native executable launcher or a local/WSL repository path; cmd launchers cannot preserve that working directory");
  if (process.platform === "win32" && /\.ps1$/i.test(executable)) {
    return spawnAgent(windowsSystemExecutable("powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", executable, ...args], { ...options, env }, interpreterDepth + 1);
  }
  if (process.platform === "win32" && !/\.(?:exe|com)$/i.test(executable)) {
    // cross-spawn resolves shebang interpreters with its own cwd-first lookup.
    // Resolve them here through the same absolute-PATH policy as the launcher.
    const file = openSync(executable, "r"); const bytes = Buffer.alloc(1024); let length: number;
    try { length = readSync(file, bytes); } finally { closeSync(file); }
    const header = bytes.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0]!;
    if (header.startsWith("#!")) {
      const words = header.slice(2).trim().split(/\s+/);
      let interpreter = words.shift()!;
      if (/(?:^|\/)env$/.test(interpreter)) interpreter = words.shift() ?? "";
      if (!interpreter || interpreter.startsWith("-") || /["']/.test(header)) throw new Error("Unsupported Agent shebang; select a native launcher or an npm cmd shim");
      interpreter = interpreter.replaceAll("\\", "/").split("/").at(-1)!;
      return spawnAgent(interpreter, [...words, executable, ...args], { ...options, env }, interpreterDepth + 1);
    }
  }
  return crossSpawn(executable, [...args], { ...options, env, windowsHide: true, shell: false });
}

/** Terminate the owned process tree on timeout, never a name-based selection. */
export function windowsSystemExecutable(name: "powershell.exe" | "taskkill.exe" | "wsl.exe"): string {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) throw new Error("Windows system directory is unavailable");
  return name === "powershell.exe" ? join(root, "System32", "WindowsPowerShell", "v1.0", name) : join(root, "System32", name);
}
export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") spawnSync(windowsSystemExecutable("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    else process.kill(-pid, "SIGKILL");
  } catch { /* The process may already have exited. */ }
}
