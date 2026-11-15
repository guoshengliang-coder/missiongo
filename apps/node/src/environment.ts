import { spawnAgent, killProcessTree, agentEnvironment } from "./launch.js";
import { readPowerShellEnvironment } from "./windows-environment.js";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { AgentConfig } from "./types.js";

export interface ClaudeLaunch { executable: string; env: NodeJS.ProcessEnv }

export function validateLaunchPaths(settings: AgentConfig): void {
  for (const [path, executable] of [[settings.environmentScript, false], [settings.executable, true], [settings.shellExecutable, true], [settings.serviceRegistration, false]] as const) {
    if (path === undefined) continue;
    if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error("Agent configuration paths must be absolute file paths");
    try {
      if (!statSync(path).isFile()) throw new Error();
      accessSync(path, executable ? constants.X_OK : constants.R_OK);
    } catch { throw new Error(executable ? "Agent launcher must be an executable file" : "Agent environment script must be a readable file"); }
  }
}

/** Only explicitly configured scripts run. No profiles, aliases, output or resolved secrets are persisted. */
export async function resolveClaudeLaunch(settings: AgentConfig, base = agentEnvironment(), timeoutMs = 5000): Promise<ClaudeLaunch> {
  validateLaunchPaths(settings);
  const executable = settings.executable ?? "claude";
  if (!settings.environmentScript) return { executable, env: { ...base } };
  if (process.platform === "win32" && /\.ps1$/i.test(settings.environmentScript)) {
    return { executable, env: await readPowerShellEnvironment(settings.environmentScript, base, timeoutMs, settings.shellExecutable) };
  }
  if (process.platform === "win32" && !settings.shellExecutable) throw new Error("Select a PowerShell .ps1 environment script, an explicit Bash executable, or WSL");
  const marker = `__MISSIONGO_ENV_${randomUUID()}__`;
  // /usr/bin/env belongs to MSYS and exports POSIX paths. Export through our
  // trusted native Node instead, so MSYS performs its native environment conversion.
  const reader = process.platform === "win32"
    ? 'source "$1" >/dev/null || exit 1; reader=$(/usr/bin/cygpath -u "$3") || exit 1; "$reader" -e "$4" "$2"'
    : 'source "$1" >/dev/null || exit 1; printf "\\0%s\\0" "$2"; /usr/bin/env -0; printf "\\0%s\\0" "$2"';
  const nativeExport = 'const f="\\0"+process.argv[1]+"\\0"; process.stdout.write(f+Object.entries(process.env).map(([k,v])=>k+"="+v).join("\\0")+f)';
  const env = await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
    const child = spawnAgent(settings.shellExecutable ?? "/bin/bash", ["--noprofile", "--norc", "-c",
      reader, "missiongo-env", settings.environmentScript!, marker, process.execPath, nativeExport], {
      cwd: (process.platform === "win32" ? base.USERPROFILE : base.HOME) ?? homedir(), env: { ...base, BASH_ENV: "/dev/null", ENV: "/dev/null" },
      detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    let output = Buffer.alloc(0);
    let settled = false;
    const stop = () => killProcessTree(child.pid);
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop(); reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Agent environment script timed out; check the script and recheck the Agent"), timeoutMs);
    child.stdout!.on("data", (part: Buffer) => {
      if (settled) return;
      if (output.length + part.length > 2_000_000) { fail("Agent environment script output exceeded the limit"); return; }
      output = Buffer.concat([output, part]);
    });
    child.on("error", () => fail("Agent environment script could not be started"));
    child.on("close", (code) => {
      if (settled) return;
      const frame = Buffer.from(`\0${marker}\0`);
      const start = output.indexOf(frame); const end = output.lastIndexOf(frame);
      if (code !== 0 || start < 0 || end <= start) { fail("Agent environment script failed; check the script and recheck the Agent"); return; }
      const values: NodeJS.ProcessEnv = {};
      for (const entry of output.subarray(start + frame.length, end).toString("utf8").split("\0")) {
        if (!entry) continue;
        const equals = entry.indexOf("=");
        if (equals <= 0) { fail("Agent environment script returned an invalid environment"); return; }
        values[entry.slice(0, equals)] = entry.slice(equals + 1);
      }
      if (!values.PATH) { fail("Agent environment script must export PATH"); return; }
      // BASH_ENV/ENV were disabled only for the reader, not supplied as client configuration.
      for (const key of ["BASH_ENV", "ENV"]) if (values[key] === "/dev/null") {
        if (base[key] === undefined) delete values[key]; else values[key] = base[key];
      }
      settled = true; clearTimeout(timer); stop(); resolve(values);
    });
  });
  return { executable, env };
}

export async function resolveAgentLaunch(kind: string, settings: AgentConfig, base = agentEnvironment()): Promise<ClaudeLaunch> {
  const launch = await resolveClaudeLaunch(settings, base);
  return { ...launch, executable: settings.executable ?? (kind === "claude_code" ? "claude" : kind) };
}

/** Heartbeats reuse memory; manual checks and each new host resolve afresh. Failed reads stay failed. */
export class ClaudeEnvironmentCache {
  private key?: string;
  private value?: Promise<ClaudeLaunch>;
  resolve = (settings: AgentConfig): Promise<ClaudeLaunch> => {
    const key = JSON.stringify(settings);
    if (key !== this.key || !this.value) {
      this.key = key; this.value = resolveClaudeLaunch(settings);
    }
    return this.value;
  };
}
