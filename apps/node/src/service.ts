import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { logsDir } from "./config.js";

/**
 * Keeping the daemon running without a terminal open.
 *
 * A machine that only listens while someone keeps a terminal window around is
 * offline most of the day, and the console can do nothing but report it as
 * such. launchd starts it at login and restarts it if it exits.
 *
 * macOS only for now: every machine this has been set up on is a Mac, and a
 * systemd unit is a separate file to get right, not a flag on this one.
 */

export const SERVICE_LABEL = "net.missiongo.node";

export function launchAgentPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

export type LaunchAgentInput = {
  nodeBinary: string;
  scriptPath: string;
  logPath: string;
  /**
   * The PATH of the shell that ran install-service. launchd starts agents with
   * a bare /usr/bin:/bin, where `claude` (usually under ~/.local/bin or a Homebrew
   * prefix) is not found — the daemon would come up, report no agents, and every
   * dispatch would fail with a missing binary nobody at the machine sees.
   */
  path: string;
  nodeHome?: string;
};

export function launchAgentPlist(input: LaunchAgentInput): string {
  const environment = [
    `    <key>PATH</key><string>${xmlEscape(input.path)}</string>`,
    ...(input.nodeHome ? [`    <key>MISSIONGO_NODE_HOME</key><string>${xmlEscape(input.nodeHome)}</string>`] : []),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(input.nodeBinary)}</string>
    <string>${xmlEscape(input.scriptPath)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- A revoked credential exits non-zero on purpose; without a throttle launchd
       would restart it in a tight loop against a server that will keep refusing. -->
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`;
}

type Launchctl = (args: readonly string[]) => void;

const runLaunchctl: Launchctl = (args) => {
  execFileSync("launchctl", [...args], { stdio: "pipe" });
};

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function installService(input: {
  scriptPath: string;
  nodeBinary?: string;
  path?: string;
  nodeHome?: string;
  home?: string;
  launchctl?: Launchctl;
}): { plistPath: string; logPath: string } {
  if (process.platform !== "darwin" && !input.launchctl) {
    throw new Error("install-service 目前只支持 macOS。其他系统请用 missiongo-node run，并交给自己的进程管理器常驻。");
  }
  const home = input.home ?? homedir();
  const launchctl = input.launchctl ?? runLaunchctl;
  const plistPath = launchAgentPath(home);
  const logPath = join(logsDir(input.nodeHome ?? home), "daemon.log");
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    plistPath,
    launchAgentPlist({
      nodeBinary: input.nodeBinary ?? process.execPath,
      scriptPath: input.scriptPath,
      logPath,
      path: input.path ?? process.env.PATH ?? "/usr/bin:/bin",
      ...(input.nodeHome ? { nodeHome: input.nodeHome } : {}),
    }),
    { mode: 0o644 },
  );
  // Replacing an existing agent: bootout first, or bootstrap refuses because the
  // label is already loaded and the old arguments keep running.
  try {
    launchctl(["bootout", `${guiDomain()}/${SERVICE_LABEL}`]);
  } catch {
    // Not loaded yet, which is the normal first install.
  }
  launchctl(["bootstrap", guiDomain(), plistPath]);
  return { plistPath, logPath };
}

export function uninstallService(input: { home?: string; launchctl?: Launchctl } = {}): { removed: boolean } {
  const home = input.home ?? homedir();
  const launchctl = input.launchctl ?? runLaunchctl;
  const plistPath = launchAgentPath(home);
  try {
    launchctl(["bootout", `${guiDomain()}/${SERVICE_LABEL}`]);
  } catch {
    // Already stopped.
  }
  if (!existsSync(plistPath)) return { removed: false };
  rmSync(plistPath);
  return { removed: true };
}
